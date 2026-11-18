// WHAT:       The Actions page: since Monday, the email, Teams and meeting items that need the owner and are not yet
//             resolved, in four sections, with All / Email / Teams / Meetings filters, "What shows" settings, and per
//             row Draft reply (email) / Open in Teams (Teams), Add as task, Edit, Done, Dismiss and Wrong?.
// WHY:        Owner-approved design 2026-11-16 (actions-proto), AC docs/qc-evidence/AC-actions-view-modules.md B-D, G.
//             Built from the app's own parts so it reads as part of the product (ship-ui-that-belongs):
//             WidgetPage + CollapsibleSection (the Priorities / Schedule frame), the ViewSwitcher pill group for the
//             filter, the bell's labelled "Dismiss" button anatomy for desktop row buttons and its "What counts"
//             anatomy for What shows, ProposalChecklistItem's "Proposed" menu chip + inline edit input on phones,
//             and Iris's email-reply card anatomy for the suggested reply. Tokens only.
//             Row writes go through the EXISTING actOnProposalFn (from:"actions"), never a new endpoint (AC-C-1).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-view.md; .claude/skills/test-agent-serverfn/scripts/actions-view-checks.mjs.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  ExternalLink,
  Flag,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CollapsibleSection, WidgetPage } from "./JourneyWidgets";
import { useHuddleStore } from "../store";
import { getActionsFn, correctActionFn, setActionsSettingsFn, actOnHeldItemFn } from "../lib/actions/actions.functions";
import { actOnProposalFn } from "../lib/proposals/proposals.functions";
import { saveEmailReplyDraftFn } from "../lib/email/email-replies.functions";
import { ACTION_SECTION_LABEL, ACTION_SECTION_ORDER, type ActionSection } from "../lib/correspondence/action-classify";
import {
  ACTIONS_RANGE_LABEL,
  ACTIONS_RANGES,
  CORRECTION_LABEL,
  CORRECTION_REASONS,
  CORRECTION_TEXT_MAX,
  DAILY_CAP_MAX,
  HIDEABLE_CATEGORIES,
  HIDEABLE_CATEGORY_LABEL,
  HELD_GROUP_LABEL,
  HELD_QUOTE_LABEL,
  OWN_NAME_CHARS,
  OWN_NAMES_MAX,
  OWN_NAMES_NOTE,
  cleanOwnNames,
  filterRows,
  tabAfterRangeChange,
  tabCounts,
  type ActionRow,
  type ActionSource,
  type ActionsSettings,
  type CorrectionReason,
} from "../lib/actions/actions";
import { ALERT_SKIP_MAX, ALERT_SKIP_MAX_CHARS, cleanAlertSkipSubjects } from "../lib/email/inbound-email";

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;
type Page = Awaited<ReturnType<typeof getActionsFn>>;
type OkPage = Extract<Page, { status: "ok" }>;
type Filter = "all" | ActionSource;

const IRIS_DM = "dm-iris-chase";
const LISTED = new Set(["proposed", "untriaged"]);
const STATE_LABEL: Record<string, string> = { approved: "Added to board", completed: "Done", dismissed: "Dismissed", delegated: "For someone", corrected: "Sent to Iris" };
const SOURCE_ICON: Record<ActionSource, typeof Mail> = { email: Mail, teams: MessageSquare, meeting: CalendarClock };
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "email", label: "Email" },
  { id: "teams", label: "Teams" },
  { id: "meeting", label: "Meetings" },
];
/** The bell's labelled-button anatomy (AttentionBell "Dismiss"), for desktop row buttons. */
const ROW_BTN =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50";

function useCaller(): Caller {
  const { user } = useAuth();
  return useMemo(() => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined), [user]);
}

function when(iso: string | null, tz: string): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  try {
    const d = new Date(t);
    const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(x);
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(d);
    if (day(d) === day(new Date())) return `Today ${time}`;
    return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d)} ${time}`;
  } catch {
    return "";
  }
}

function sinceLabel(iso: string, tz: string, short: boolean, range: ActionsSettings["range"] = "week"): string {
  // Owner 2026-11-17: the header names the chosen range ("Since Mon" or "All time").
  if (range === "all") return ACTIONS_RANGE_LABEL.all;
  try {
    return short
      ? `Since ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(iso))}`
      : `Since Monday, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(iso))}`;
  } catch {
    return "Since Monday";
  }
}

type RowLocal = { state?: string; title?: string; busy?: boolean; draftSaved?: string | null };

export function ActionsView() {
  const caller = useCaller();
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [showSettings, setShowSettings] = useState(false);
  const [local, setLocal] = useState<Record<string, RowLocal>>({});

  const load = useCallback(async () => {
    if (!caller) {
      setPage({ status: "signed_out" });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setPage(await getActionsFn({ data: { caller } }));
      setLocal({});
    } catch {
      setPage({ status: "error", error: "Couldn't load your actions." });
    } finally {
      setLoading(false);
    }
  }, [caller]);

  useEffect(() => {
    void load();
  }, [load]);

  const ok = page?.status === "ok" ? (page as OkPage) : null;
  const tz = ok?.settings.timeZone ?? "America/New_York";
  const patch = (id: string, p: RowLocal) => setLocal((m) => ({ ...m, [id]: { ...m[id], ...p } }));

  // Rows still open (a row the owner just acted on stays, marked, until the next load; it no longer counts).
  const openRows = useMemo(() => (ok ? ok.rows.filter((r) => LISTED.has(local[r.id]?.state ?? r.state)) : []), [ok, local]);
  // 2026-11-17: the tabs count the not-checked items too (owner: All time showed "120 not checked yet" while every
  // tab still read the This-week numbers). The selection already applied the What-shows switches to both lists.
  const unchecked = useMemo(() => (ok ? ok.unchecked.filter((r) => ok.settings.sources[r.source]) : []), [ok]);
  // F5: items held by the safety check count on the tabs too, and follow the tab (F5-10 / F5-11).
  const held = useMemo(() => (ok ? (ok.held ?? []).filter((r) => ok.settings.sources[r.source]) : []), [ok]);
  const counts = useMemo(() => tabCounts(openRows, unchecked, held), [openRows, unchecked, held]);
  const visible = ok ? ok.rows.filter((r) => (filter === "all" || r.source === filter) && ok.settings.sources[r.source]) : [];
  const visibleUnchecked = filterRows(unchecked, filter);
  const visibleHeld = filterRows(held, filter);

  async function saveSettings(next: ActionsSettings) {
    if (!ok || !caller) return;
    const prev = ok.settings;
    setPage({ ...ok, settings: next });
    const r = await setActionsSettingsFn({ data: { caller, settings: next as unknown as Record<string, unknown> } }).catch(() => null);
    if (!r?.ok) {
      setPage({ ...ok, settings: prev }); // AC-D-7: a failed save rolls back
      toast.error(r?.error ?? "Couldn't save that setting.");
      return;
    }
    void load(); // hidden categories / sources re-select from the stored verdicts (no model call)
  }

  return (
    <WidgetPage
      title="Actions"
      subtitle={
        ok ? (
          <>
            {/* `app-hidden`, never Tailwind's `hidden`: an extension's injected `.hidden` rule once collided with it. */}
            <span className="md:app-hidden">{sinceLabel(ok.sinceIso, tz, true, ok.settings.range)}</span>
            <span className="app-hidden md:inline">{sinceLabel(ok.sinceIso, tz, false, ok.settings.range)}</span>
          </>
        ) : null
      }
    >
      {ok?.capNotice && (
        // Owner 2026-11-17: say WHY items stopped being checked and where to change it. The app's existing notice band
        // (PolishView's "You edited the polished text..." band: border-warning/40 + bg-band-cream), tokens only. Text is
        // text-foreground, not PolishView's text-warning-foreground, which is near-black on the dark-theme band.
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-band-cream px-3 py-2 text-[12px] text-foreground sm:px-6" data-testid="actions-cap-notice">
          <span className="flex-[1_1_220px]">{ok.capNotice}</span>
          {!showSettings && (
            <button type="button" onClick={() => setShowSettings(true)} className={cn(ROW_BTN, "min-h-9 md:min-h-0")} data-testid="actions-cap-open-settings">
              Change limit
            </button>
          )}
        </div>
      )}
      {ok && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-3 py-2 sm:px-6">
          {/* The ViewSwitcher inline pill anatomy; scrolls sideways inside itself on a phone (AC-G-2). */}
          <div className="min-w-0 overflow-x-auto">
            <div className="inline-flex rounded-lg border border-hairline bg-surface p-0.5" role="group" aria-label="Show">
              {FILTERS.filter((f) => f.id === "all" || ok.settings.sources[f.id as ActionSource]).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  data-testid={`actions-filter-${f.id}`}
                  className={cn(
                    "whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition",
                    filter === f.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label} <span className="tabular-nums">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Range (owner 2026-11-17: "all time vs this week"): the same pill anatomy as the filter group. Saved in the
              Actions settings, so the page AND the heartbeat classify pass both use it (actionsWindowStartMs). */}
          <div className="inline-flex shrink-0 rounded-lg border border-hairline bg-surface p-0.5" role="group" aria-label="Range" data-testid="actions-range">
            {ACTIONS_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  if (ok.settings.range === r) return;
                  // 2026-11-17: a range change resets the type tab to All, so the owner never lands on a tab that is
                  // empty in the new range.
                  setFilter((f) => tabAfterRangeChange(f, ok.settings.range, r));
                  void saveSettings({ ...ok.settings, range: r });
                }}
                aria-pressed={ok.settings.range === r}
                data-testid={`actions-range-${r}`}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition",
                  ok.settings.range === r ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {ACTIONS_RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            data-testid="actions-what-shows"
            className="ml-auto inline-flex min-h-9 shrink-0 items-center whitespace-nowrap text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showSettings ? "Done" : `What shows${ok.hidden.total ? ` · ${ok.hidden.total} hidden` : ""}`}
          </button>
        </div>
      )}
      {ok && showSettings && <WhatShows settings={ok.settings} hidden={ok.hidden} meetingOthersHidden={ok.meetingOthersHidden} onChange={saveSettings} />}

      {loading && !page ? (
        <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-muted-foreground sm:px-6">
          <Loader2 size={13} className="animate-spin" aria-hidden /> Loading your actions…
        </div>
      ) : !page || page.status === "error" ? (
        <div className="px-3 py-4 text-[12px] sm:px-6" data-testid="actions-error">
          <p className="text-destructive">Couldn’t load your actions{page && "error" in page && page.error ? ` — ${page.error}` : "."}</p>
          <button type="button" onClick={() => void load()} className={cn(ROW_BTN, "mt-2")}>
            <RotateCcw size={11} aria-hidden /> Retry
          </button>
        </div>
      ) : page.status === "signed_out" ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6">Sign in to see what needs you.</p>
      ) : page.status === "off" ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6" data-testid="actions-off">
          Actions isn’t switched on yet: Huddle isn’t storing your email and Teams for this account.
        </p>
      ) : (
        <ActionsBody
          page={ok!}
          visible={visible}
          unchecked={visibleUnchecked}
          held={visibleHeld}
          openCount={openRows.length}
          local={local}
          patch={patch}
          caller={caller}
          tz={tz}
          reload={load}
        />
      )}
    </WidgetPage>
  );
}

function ActionsBody({
  page,
  visible,
  unchecked,
  held,
  openCount,
  local,
  patch,
  caller,
  tz,
  reload,
}: {
  page: OkPage;
  visible: ActionRow[];
  /** The not-checked items under the current type tab (already through the What-shows switches). */
  unchecked: ActionRow[];
  /** F5: the items held by the safety check under the current type tab (already through the What-shows switches). */
  held: ActionRow[];
  openCount: number;
  local: Record<string, RowLocal>;
  patch: (id: string, p: RowLocal) => void;
  caller: Caller;
  tz: string;
  reload: () => Promise<void>;
}) {
  const bySection = (s: ActionSection) => visible.filter((r) => r.section === s);
  // 2026-11-17 (owner: "All time" showed only "120 not checked yet"): the items are LISTED, not just counted, in a
  // collapsed section. They have no AI verdict, so they carry no row actions that would claim they were judged:
  // who, what, when, a short preview and an Open link only.
  const notChecked = page.notChecked ? (
    <div data-testid="actions-not-checked" data-count={page.notChecked}>
      <CollapsibleSection id="actions-not-checked" label="Not checked yet" count={unchecked.length} defaultOpen={false}>
        <p className="px-3 pb-1 pt-1 text-[11px] text-muted-foreground sm:px-6" data-testid="actions-not-checked-note">
          {page.classifyOn
            ? "Huddle hasn’t sorted these yet, so they may or may not need you. They are checked a few at a time."
            : "Sorting is switched off in What shows, so these haven’t been checked."}
        </p>
        {unchecked.length ? (
          <ul className="divide-y divide-hairline" data-testid="actions-not-checked-list">
            {unchecked.map((r) => (
              <UncheckedRowItem key={r.itemKey} row={r} tz={tz} />
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 text-[11px] text-muted-foreground sm:px-6">None of this type.</p>
        )}
      </CollapsibleSection>
    </div>
  ) : null;
  // F5 (owner-approved 2026-11-18): items the safety check held, in their own group, EXPANDED (not a collapsed
  // section), after the judged sections and before "Not checked yet". Absent when empty.
  const heldGroup = held.length ? (
    <section className="border-t border-hairline" data-testid="actions-held" data-count={held.length}>
      <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-6" data-testid="actions-held-heading">
        {HELD_GROUP_LABEL} <span className="tabular-nums">{held.length}</span>
      </h3>
      <ul className="divide-y divide-hairline" data-testid="actions-held-list">
        {held.map((r) => (
          <HeldRowItem key={r.itemKey} row={r} caller={caller} tz={tz} reload={reload} />
        ))}
      </ul>
    </section>
  ) : null;
  // AC-B-7: never "caught up" when nothing was ever sorted.
  if (!page.rows.length && page.neverClassified) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6" data-testid="actions-not-sorted">
        {page.classifyOn
          ? "Huddle hasn’t sorted your mail and chats yet. New items are checked every few minutes."
          : "Sorting is switched off, so nothing has been checked. Turn it on in What shows."}
        {notChecked}
      </div>
    );
  }
  return (
    <div className="pb-4">
      {openCount === 0 &&
        (page.notChecked ? (
          <p className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6" data-testid="actions-nothing-sorted-open">
            Nothing checked so far needs you. {page.notChecked} {page.notChecked === 1 ? "item hasn’t" : "items haven’t"} been checked yet (below).
          </p>
        ) : held.length ? (
          <p className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6" data-testid="actions-nothing-sorted-open">
            Nothing checked so far needs you for sure. {held.length} {held.length === 1 ? "item was" : "items were"} held back for you to decide (below).
          </p>
        ) : (
          <p className="px-3 py-4 text-[12px] text-muted-foreground sm:px-6" data-testid="actions-caught-up">
            You’re all caught up.
          </p>
        ))}
      {ACTION_SECTION_ORDER.map((s) => {
        const rows = bySection(s);
        const open = rows.filter((r) => LISTED.has(local[r.id]?.state ?? r.state)).length;
        return (
          <div key={s}>
            {rows.length > 0 && (
              <CollapsibleSection id={`actions-${s}`} label={ACTION_SECTION_LABEL[s]} count={open}>
                <ul className="divide-y divide-hairline" data-testid={`actions-section-${s}`}>
                  {rows.map((r) => (
                    <ActionRowItem key={r.id} row={r} local={local[r.id] ?? {}} patch={patch} caller={caller} tz={tz} />
                  ))}
                </ul>
              </CollapsibleSection>
            )}
            {s === "needs_reply" && page.answered.length > 0 && (
              <CollapsibleSection id="actions-answered" label="Answered by your reply" count={page.answered.length} defaultOpen={false}>
                <ul className="divide-y divide-hairline" data-testid="actions-answered">
                  {page.answered.map((r) => (
                    <li key={r.itemKey} className="flex items-start gap-2 px-3 py-2 sm:px-6">
                      <Check size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-muted-foreground" title={r.title}>
                          {r.title}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">{[r.who, r.sourceLabel, when(r.at, tz)].filter(Boolean).join(" · ")}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </CollapsibleSection>
            )}
          </div>
        );
      })}
      {page.corrected.length > 0 && (
        <CollapsibleSection id="actions-corrected" label="Sent back as wrong" count={page.corrected.length} defaultOpen={false}>
          <ul className="divide-y divide-hairline" data-testid="actions-corrected">
            {page.corrected.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-muted-foreground" title={r.title}>
                    {r.title}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{[r.who, r.sourceLabel].filter(Boolean).join(" · ")}</p>
                </div>
                <button
                  type="button"
                  className={cn(ROW_BTN, "min-h-11 md:min-h-0")}
                  disabled={!caller?.entra_email}
                  onClick={async () => {
                    const res = await correctActionFn({ data: { caller, proposalId: r.id, itemKey: r.itemKey, undo: true, listSender: r.listSender } }).catch(() => null);
                    if (!res?.ok) toast.error(res?.error ?? "Couldn't undo that.");
                    else void reload();
                  }}
                >
                  <RotateCcw size={11} aria-hidden /> Undo
                </button>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}
      {heldGroup}
      {notChecked}
    </div>
  );
}

/** F5: an item the safety check HELD. Shows the AI's suggested to-do, who / where, the FIXED reason sentence, and
 *  the AI's quote labelled as not found. Add as task / Dismiss create the proposal at click time (actOnHeldItemFn ->
 *  the existing proposeFromSource + actOnProposal). */
function HeldRowItem({ row, caller, tz, reload }: { row: ActionRow; caller: Caller; tz: string; reload: () => Promise<void> }) {
  const Icon = SOURCE_ICON[row.source];
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "approve" | "dismiss">(null);
  const meta = [row.who, row.sourceLabel, when(row.at, tz)].filter(Boolean).join(" · ");
  const signedOut = !caller?.entra_email;
  async function act(action: "approve" | "dismiss") {
    if (busy || done) return;
    setBusy(true);
    const r = await actOnHeldItemFn({ data: { caller, itemKey: row.itemKey, action } }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      toast.error(r?.error ?? "Couldn't add that. Try again.");
      return;
    }
    setDone(action);
    if (r.note) toast(r.note);
    else toast.success(action === "approve" ? "Added to your board." : "Dismissed.");
    void reload();
  }
  return (
    <li className="px-3 py-2.5 sm:px-6" data-testid="actions-held-row" data-source={row.source}>
      <div className="flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("break-words text-[13px] font-medium leading-snug", done ? "text-muted-foreground line-through" : "text-foreground")} data-testid="actions-held-title">
            {row.title || "(no subject)"}
          </p>
          <p className="break-words text-[11px] text-muted-foreground">{done ? (done === "approve" ? STATE_LABEL.approved : STATE_LABEL.dismissed) : meta}</p>
          <p className="mt-0.5 text-[12px] text-foreground/80" data-testid="actions-held-reason">
            {row.heldReason}
          </p>
          {row.quote ? (
            <p className="mt-0.5 break-words text-[12px] text-muted-foreground" data-testid="actions-held-quote">
              {row.heldQuoteLabel ?? HELD_QUOTE_LABEL}: “{row.quote}”
            </p>
          ) : null}
          {!done && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="actions-held-buttons">
              <button type="button" className={cn(ROW_BTN, "min-h-11 md:min-h-0")} disabled={busy || signedOut} onClick={() => void act("approve")} data-testid="actions-held-add">
                {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Plus size={11} aria-hidden />} Add as task
              </button>
              <button type="button" className={cn(ROW_BTN, "min-h-11 md:min-h-0")} disabled={busy || signedOut} onClick={() => void act("dismiss")} data-testid="actions-held-dismiss">
                <X size={11} aria-hidden /> Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A not-checked item (no AI verdict yet). Read-only on purpose: no Add as task / Done / Dismiss / Wrong?, which
 *  would act on a judgement that was never made. Open goes to the source (Teams: the chat link; email: Outlook, where
 *  the subject finds it -- the same link the suggested-reply card uses). */
function UncheckedRowItem({ row, tz }: { row: ActionRow; tz: string }) {
  const Icon = SOURCE_ICON[row.source];
  const [expanded, setExpanded] = useState(false);
  const meta = [row.who, row.sourceLabel, when(row.at, tz)].filter(Boolean).join(" · ");
  const link = row.source === "teams" ? row.teamsLink : row.source === "email" ? "https://outlook.office.com/mail/" : null;
  return (
    <li className="px-3 py-2 sm:px-6" data-testid="actions-not-checked-row" data-source={row.source}>
      <div className="flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("text-[13px] leading-snug text-foreground", expanded ? "whitespace-pre-wrap break-words" : "truncate")} title={row.title} onClick={() => setExpanded((x) => !x)}>
            {row.title || "(no subject)"}
          </p>
          <p className={cn("text-[11px] text-muted-foreground", expanded ? "break-words" : "truncate")} title={meta}>
            {meta}
          </p>
          {row.preview && (
            <p
              className={cn("mt-0.5 text-[12px] text-foreground/80", expanded ? "whitespace-pre-wrap break-words" : "line-clamp-2")}
              onClick={() => setExpanded((x) => !x)}
              data-testid="actions-not-checked-preview"
            >
              {row.preview}
            </p>
          )}
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(ROW_BTN, "min-h-11 md:min-h-0")}
            title={row.source === "email" ? "Opens Outlook; find the email by its subject" : "Opens the chat in Teams"}
            data-testid="actions-not-checked-open"
          >
            <ExternalLink size={11} aria-hidden /> Open
          </a>
        )}
      </div>
    </li>
  );
}

function ActionRowItem({ row, local, patch, caller, tz }: { row: ActionRow; local: RowLocal; patch: (id: string, p: RowLocal) => void; caller: Caller; tz: string }) {
  const signedOut = !caller?.entra_email;
  const state = local.state ?? row.state;
  const title = local.title ?? row.title;
  const busy = !!local.busy;
  const open = state === "proposed";
  const triaging = state === "untriaged";
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [panel, setPanel] = useState<null | "wrong" | "reply">(null);
  // 2026-11-17 (owner: "the text areas don't expand so the text is cut off"): tap the text, or "More", to read the
  // full title, meta line, summary and quote; tap again ("Less") to fold it back. Display only.
  const [expanded, setExpanded] = useState(false);
  // Loop-2 UI: "More" shows only when some text is actually cut off (measured: scroll size > box), re-measured when
  // the row resizes (phone rotation, panel width). While expanded it stays so "Less" can fold the row back.
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const metaRef = useRef<HTMLParagraphElement | null>(null);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const els = [titleRef.current, metaRef.current, summaryRef.current].filter((e): e is HTMLParagraphElement => !!e);
    const measure = () => setTruncated(els.some((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  });
  const Icon = SOURCE_ICON[row.source];

  async function act(action: "approve" | "complete" | "dismiss" | "edit" | "triage", extra: { title?: string; choice?: "mine" | "someone" | "skip"; name?: string } = {}) {
    if (busy) return; // one write in flight per row
    const before = { state, title };
    const optimistic: RowLocal =
      action === "edit"
        ? { title: extra.title }
        : action === "triage"
          ? { state: extra.choice === "mine" ? "proposed" : extra.choice === "someone" ? "delegated" : "dismissed" }
          : { state: action === "approve" ? "approved" : action === "complete" ? "completed" : "dismissed" };
    patch(row.id, { ...optimistic, busy: true });
    try {
      const r = await actOnProposalFn({ data: { caller, id: row.id, action, from: "actions", ...extra } });
      if (r.row) patch(row.id, { state: r.row.state, title: r.row.title, busy: false });
      if (!r.ok) {
        if (!r.row) patch(row.id, { ...before, busy: false });
        toast.error(r.error || "Couldn't update that.");
        return;
      }
      if (!r.row) patch(row.id, { busy: false });
      if (r.alreadyOnBoard || r.note) toast(r.note ?? "It was already on your board.");
    } catch (err) {
      patch(row.id, { ...before, busy: false }); // AC-C-7: back to exactly the prior state
      toast.error(err instanceof Error ? err.message : "Couldn't update that.");
    }
  }

  function saveEdit() {
    const t = draft.trim();
    setEditing(false);
    if (!t || t === title) return;
    void act("edit", { title: t.slice(0, 200) });
  }
  function saveName() {
    const n = draft.trim();
    setNaming(false);
    if (!n) return;
    void act("triage", { choice: "someone", name: n.slice(0, 80) });
  }

  function askIris(text: string) {
    const st = useHuddleStore.getState();
    st.setActive(IRIS_DM);
    st.setView("huddle");
    st.setDraftPrefill(text);
  }
  const subject = row.replyAsk?.subject ? ` ("${row.replyAsk.subject}")` : "";
  const redo = () => askIris(`For the reply to ${row.replyAsk?.who ?? row.who}${subject}, change it to: `);
  const askDraft = () => askIris(`Draft a reply to ${row.replyAsk?.who ?? row.who}${subject}: `);

  async function draftReply() {
    const rep = row.reply;
    if (!rep) return askDraft(); // OQ-12: no reply row -> ask Iris through the existing reply path
    if (!rep.draftable) return setPanel((p) => (p === "reply" ? null : "reply"));
    patch(row.id, { busy: true });
    try {
      const r = await saveEmailReplyDraftFn({ data: { caller, emailId: rep.emailReplyId } });
      patch(row.id, { busy: false, ...(r.ok ? { draftSaved: r.webLink ?? "" } : {}) });
      if (r.ok) toast.success("Draft saved in your Outlook Drafts — send it from there");
      else toast.error(r.error ?? "Couldn't save the draft.");
    } catch {
      patch(row.id, { busy: false });
      toast.error("Couldn't save the draft.");
    }
  }

  const closedLabel = STATE_LABEL[state] ?? state;
  const meta = [row.who, row.sourceLabel, when(row.at, tz), row.assignee ? `For ${row.assignee}` : ""].filter(Boolean).join(" · ");
  const draftSaved = local.draftSaved !== undefined || row.reply?.status === "drafted";
  const canAct = (open || triaging) && !busy && !signedOut;
  const teamsLink = row.source === "teams" ? row.teamsLink : null;

  const menuItems = (
    <>
      {row.source === "email" && (
        <DropdownMenuItem onClick={() => void draftReply()}>
          <Mail size={12} className="mr-2" /> Draft reply
        </DropdownMenuItem>
      )}
      {teamsLink && (
        <DropdownMenuItem asChild>
          <a href={teamsLink} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={12} className="mr-2" /> Open in Teams
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={() => void act("approve")}>
        <Plus size={12} className="mr-2" /> Add as task
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
      >
        <Pencil size={12} className="mr-2" /> Edit
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void act("complete")}>
        <CheckCheck size={12} className="mr-2" /> Done
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void act("dismiss")}>
        <X size={12} className="mr-2" /> Dismiss
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setPanel("wrong")}>
        <Flag size={12} className="mr-2" /> Wrong?
      </DropdownMenuItem>
    </>
  );
  const triageItems = (
    <>
      <DropdownMenuItem onClick={() => void act("triage", { choice: "mine" })}>
        <UserRound size={12} className="mr-2" /> Mine
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          setDraft("");
          setNaming(true);
        }}
      >
        <Users size={12} className="mr-2" /> For someone
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void act("triage", { choice: "skip" })}>
        <X size={12} className="mr-2" /> Skip
      </DropdownMenuItem>
    </>
  );

  return (
    <li className="px-3 py-2.5 sm:px-6" data-testid="actions-row" data-source={row.source}>
      <div className="flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          {editing || naming ? (
            <input
              autoFocus
              aria-label={naming ? `Who is "${title}" for?` : "Edit this item"}
              placeholder={naming ? "Who is it for?" : undefined}
              value={draft}
              maxLength={naming ? 80 : 200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={naming ? saveName : saveEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (naming ? saveName : saveEdit)();
                if (e.key === "Escape") {
                  setEditing(false);
                  setNaming(false);
                }
              }}
              className="w-full rounded border border-hairline bg-background px-1.5 py-0.5 text-[13px]"
            />
          ) : (
            <p
              ref={titleRef}
              className={cn("text-[13px] font-medium leading-snug", expanded ? "whitespace-pre-wrap break-words" : "truncate", open || triaging ? "text-foreground" : "text-muted-foreground line-through")}
              title={title}
              onClick={() => setExpanded((x) => !x)}
              data-testid="actions-row-title"
            >
              {title}
            </p>
          )}
          {editing ? (
            <p className="text-[10px] text-muted-foreground">Enter saves · Esc cancels</p>
          ) : (
            <p ref={metaRef} className={cn("text-[11px] text-muted-foreground", expanded ? "break-words" : "truncate")} title={meta}>
              {open || triaging ? meta : closedLabel}
              {draftSaved && (open || triaging) ? " · Draft saved" : ""}
            </p>
          )}
          {(open || triaging) && row.reasonLine && (
            <p
              ref={summaryRef}
              className={cn("mt-0.5 text-[12px] text-foreground/80", expanded ? "whitespace-pre-wrap break-words" : "line-clamp-2")}
              onClick={() => setExpanded((x) => !x)}
              data-testid="actions-row-summary"
            >
              {row.reasonLine}
              {row.quote ? <span className="text-muted-foreground"> “{row.quote}”</span> : null}
            </p>
          )}
          {!editing && !naming && (truncated || expanded) && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((x) => !x)}
              className="-my-2.5 inline-flex min-h-11 items-center text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              data-testid="actions-row-more"
            >
              {expanded ? "Less" : "More"}
            </button>
          )}
          {/* Desktop: labelled buttons (a full page has room). Phone: the menu chip below. */}
          {(open || triaging) && (
            <div className="app-hidden mt-1.5 flex-wrap items-center gap-1.5 md:flex" data-testid="actions-row-buttons">
              {triaging ? (
                <>
                  <span className="text-[11px] text-muted-foreground">To sort</span>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => void act("triage", { choice: "mine" })}>
                    <UserRound size={11} aria-hidden /> Mine
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => (setDraft(""), setNaming(true))}>
                    <Users size={11} aria-hidden /> For someone
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => void act("triage", { choice: "skip" })}>
                    <X size={11} aria-hidden /> Skip
                  </button>
                </>
              ) : (
                <>
                  {row.source === "email" && (
                    <button type="button" className={ROW_BTN} disabled={busy || signedOut} onClick={() => void draftReply()} data-testid="actions-draft-reply">
                      <Mail size={11} aria-hidden /> Draft reply
                    </button>
                  )}
                  {teamsLink && (
                    <a href={teamsLink} target="_blank" rel="noopener noreferrer" className={ROW_BTN} data-testid="actions-open-teams">
                      <ExternalLink size={11} aria-hidden /> Open in Teams
                    </a>
                  )}
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => void act("approve")}>
                    <Plus size={11} aria-hidden /> Add as task
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => (setDraft(title), setEditing(true))}>
                    <Pencil size={11} aria-hidden /> Edit
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => void act("complete")}>
                    <CheckCheck size={11} aria-hidden /> Done
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} onClick={() => void act("dismiss")}>
                    <X size={11} aria-hidden /> Dismiss
                  </button>
                  <button type="button" className={ROW_BTN} disabled={!canAct} aria-expanded={panel === "wrong"} onClick={() => setPanel((p) => (p === "wrong" ? null : "wrong"))}>
                    <Flag size={11} aria-hidden /> Wrong?
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {/* Phone: ProposalChecklistItem's "Proposed" menu chip, the same items (AC-G-1). */}
        <div className="md:app-hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!canAct}>
              <button
                type="button"
                aria-label={`Actions for "${title}"`}
                className="-my-1 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-md border border-dashed border-hairline bg-muted px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <span>{open ? "Proposed" : triaging ? "To sort" : closedLabel}</span>}
                <ChevronDown size={9} className="opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {triaging ? triageItems : menuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {panel === "reply" && row.reply && <SuggestedReply row={row} onRedo={redo} />}
      {panel === "wrong" && (
        <WrongPanel
          row={row}
          caller={caller}
          onClose={() => setPanel(null)}
          onSent={() => {
            patch(row.id, { state: "corrected" });
            setPanel(null);
          }}
          onUndone={() => patch(row.id, { state: row.state })}
        />
      )}
    </li>
  );
}

/** Work-mailbox email: Iris's suggested reply, Copy / Open in Outlook / Redo (owner chose copy-and-paste). The
 *  anatomy of Iris's own email-reply card (HuddleView EmailReplyRow). */
function SuggestedReply({ row, onRedo }: { row: ActionRow; onRedo: () => void }) {
  const text = row.reply?.proposedReply?.trim() ?? "";
  return (
    <div className="ml-6 mt-2 rounded-lg border border-hairline p-2" data-testid="actions-suggested-reply">
      {text ? (
        <>
          <p className="text-[11px] font-semibold text-muted-foreground">Iris’s suggested reply</p>
          <blockquote className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap border-l-2 pl-3 text-[13px] leading-relaxed text-foreground">{text}</blockquote>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">Iris hasn’t suggested a reply yet.</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {text && (
          <button
            type="button"
            className={cn(ROW_BTN, "min-h-11 md:min-h-0")}
            onClick={() =>
              navigator.clipboard
                ?.writeText(text)
                .then(() => toast.success("Reply copied — paste it into your work Outlook"))
                .catch(() => toast.error("Couldn't copy — select the text above instead."))
            }
          >
            <Copy size={11} aria-hidden /> Copy reply
          </button>
        )}
        {text && (
          <a href="https://outlook.office.com/mail/" target="_blank" rel="noopener noreferrer" className={cn(ROW_BTN, "min-h-11 md:min-h-0")} title="Opens Outlook; find the email by its subject">
            <ExternalLink size={11} aria-hidden /> Open in Outlook
          </a>
        )}
        <button type="button" className={cn(ROW_BTN, "min-h-11 md:min-h-0")} onClick={onRedo}>
          <Pencil size={11} aria-hidden /> Redo with Iris
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Work mailbox: Huddle can’t save drafts there, so copy the reply and paste it into the email. Nothing is ever sent.</p>
    </div>
  );
}

function WrongPanel({ row, caller, onClose, onSent, onUndone }: { row: ActionRow; caller: Caller; onClose: () => void; onSent: () => void; onUndone: () => void }) {
  const [reason, setReason] = useState<CorrectionReason | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const reasons = CORRECTION_REASONS.filter((r) => r !== "stop_list" || row.fromList);
  // 2026-11-17: the note grows with what is typed (it used to scroll inside two fixed lines on a phone).
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  async function send() {
    if (!reason || busy) return;
    setBusy(true);
    const r = await correctActionFn({ data: { caller, proposalId: row.id, reason, text: text.trim() || undefined, itemKey: row.itemKey, listSender: reason === "stop_list" ? row.listSender : null } }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      toast.error(r?.error ?? "Couldn't send that.");
      return;
    }
    onSent();
    toast("Sent back to Iris. It leaves your list.", {
      action: {
        label: "Undo",
        onClick: () =>
          void correctActionFn({ data: { caller, proposalId: row.id, itemKey: row.itemKey, undo: true, listSender: row.listSender } }).then((u) => (u.ok ? onUndone() : toast.error(u.error ?? "Couldn't undo that."))),
      },
    });
  }
  return (
    <div className="ml-6 mt-2 rounded-lg border border-hairline p-2" data-testid="actions-wrong-panel">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium text-foreground">What is wrong with this one?</p>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
          <X size={13} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {reasons.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              "min-h-9 rounded-full border px-2.5 py-1 text-[11px] transition",
              reason === r ? "border-primary bg-primary text-primary-foreground" : "border-hairline text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {CORRECTION_LABEL[r]}
          </button>
        ))}
      </div>
      <textarea
        ref={taRef}
        value={text}
        maxLength={CORRECTION_TEXT_MAX}
        onChange={(e) => setText(e.target.value)}
        placeholder="Optional: tell Iris why"
        rows={2}
        data-testid="actions-wrong-text"
        className="mt-2 w-full resize-none overflow-hidden rounded border border-hairline bg-background px-2 py-1 text-[13px]"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">The row leaves the list, and the reason goes back to the step that sorts your mail.</p>
        <button type="button" disabled={!reason || busy} onClick={() => void send()} className={cn(ROW_BTN, "min-h-11 font-semibold text-foreground md:min-h-8")}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} aria-hidden />} Send
        </button>
      </div>
    </div>
  );
}

/** "What shows": the bell's "What counts" anatomy (a header row + checkbox labels). Server-stored (AC-D-7). */
function WhatShows({
  settings,
  hidden,
  meetingOthersHidden,
  onChange,
}: {
  settings: ActionsSettings;
  hidden: OkPage["hidden"];
  meetingOthersHidden: number;
  onChange: (s: ActionsSettings) => void;
}) {
  const label = "flex min-h-8 items-center gap-2 text-xs";
  const head = "pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
  const toggleCat = (c: (typeof HIDEABLE_CATEGORIES)[number]) =>
    onChange({ ...settings, hideCategories: settings.hideCategories.includes(c) ? settings.hideCategories.filter((x) => x !== c) : [...settings.hideCategories, c] });
  return (
    <div className="space-y-1.5 border-b border-hairline bg-surface px-3 py-2 sm:px-6" data-testid="actions-settings">
      <p className={head}>Hide these kinds of mail</p>
      {HIDEABLE_CATEGORIES.map((c) => (
        <label key={c} className={label}>
          <input type="checkbox" checked={settings.hideCategories.includes(c)} onChange={() => toggleCat(c)} />
          {HIDEABLE_CATEGORY_LABEL[c]}
          {hidden.categories[c] ? <span className="text-muted-foreground">({hidden.categories[c]} hidden)</span> : null}
        </label>
      ))}
      <p className={head}>Teams</p>
      <label className={label}>
        <input type="checkbox" checked={settings.hideUninvolvedChats} onChange={() => onChange({ ...settings, hideUninvolvedChats: !settings.hideUninvolvedChats })} data-testid="actions-hide-uninvolved" />
        <span>
          Hide group and meeting chats I never wrote in
          <span className="block text-[11px] text-muted-foreground">Unless someone @mentioned you.{hidden.uninvolved ? ` ${hidden.uninvolved} hidden.` : ""}</span>
        </span>
      </label>
      {/* F4 (owner-approved 2026-11-18): "Names that are you". One name per line; seeded from the configured full
          names until saved. A Teams sender with one of these full names is you (your other account), never someone
          asking you. Saved like every other setting here (setActionsSettingsFn). */}
      <label className="block text-xs" data-testid="actions-own-names-field">
        <span className="block">Names that are you</span>
        <span className="block text-[11px] text-muted-foreground">
          One full name per line (first and last). A Teams message from one of these names counts as yours. {OWN_NAMES_NOTE}
        </span>
        <textarea
          key={settings.ownNames.join("\n")}
          defaultValue={settings.ownNames.join("\n")}
          rows={Math.max(2, Math.min(OWN_NAMES_MAX, settings.ownNames.length + 1))}
          maxLength={OWN_NAMES_MAX * (OWN_NAME_CHARS + 1)}
          onBlur={(e) => {
            const next = cleanOwnNames(e.target.value.split("\n"));
            if (next.join("\n") !== settings.ownNames.join("\n")) onChange({ ...settings, ownNames: next });
          }}
          data-testid="actions-own-names"
          className="mt-1 w-full max-w-sm resize-y rounded border border-hairline bg-background px-1.5 py-0.5 text-xs"
        />
      </label>
      {/* Owner 2026-11-18: "Meeting minutes should not trigger Iris to send me a draft in the chat. It should be a part of
          an exclusion list." The list lives on this same settings row; the inbound alert runner reads it once per check.
          Seeded "meeting minutes" until saved; a cleared field stays empty. ACs: docs/qc-evidence/AC-inbound-alert-exclusions.md */}
      <label className="block text-xs" data-testid="actions-alert-skip-field">
        <span className="block">Emails Iris won&rsquo;t alert you about</span>
        <span className="block text-[11px] text-muted-foreground">
          One phrase per line. When a new email&rsquo;s subject contains one, Iris doesn&rsquo;t tell you about it or draft a
          reply. Case doesn&rsquo;t matter. Replies and forwards (Re:/Fw:) still alert. This doesn&rsquo;t change what this list
          shows. Applies from the next email check.
        </span>
        <textarea
          key={settings.alertSkipSubjects.join("\n")}
          defaultValue={settings.alertSkipSubjects.join("\n")}
          rows={Math.max(2, Math.min(8, settings.alertSkipSubjects.length + 1))}
          maxLength={ALERT_SKIP_MAX * (ALERT_SKIP_MAX_CHARS + 1)}
          onBlur={(e) => {
            const next = cleanAlertSkipSubjects(e.target.value.split("\n"));
            if (next.join("\n") !== settings.alertSkipSubjects.join("\n")) onChange({ ...settings, alertSkipSubjects: next });
          }}
          data-testid="actions-alert-skip"
          className="mt-1 w-full max-w-sm resize-y rounded border border-hairline bg-background px-1.5 py-0.5 text-xs"
        />
      </label>
      <p className={head}>Sources</p>
      {(["email", "teams", "meeting"] as const).map((s) => (
        <label key={s} className={label}>
          <input type="checkbox" checked={settings.sources[s]} onChange={() => onChange({ ...settings, sources: { ...settings.sources, [s]: !settings.sources[s] } })} />
          {s === "email" ? "Email" : s === "teams" ? "Teams" : "Meeting notes"}
          {s === "meeting" && meetingOthersHidden ? <span className="text-muted-foreground">(only yours or unassigned; {meetingOthersHidden} for others not shown)</span> : null}
        </label>
      ))}
      {settings.hiddenSenders.length > 0 && (
        <>
          <p className={head}>Lists you stopped flagging</p>
          {settings.hiddenSenders.map((s) => (
            <label key={s} className={label}>
              <input type="checkbox" checked onChange={() => onChange({ ...settings, hiddenSenders: settings.hiddenSenders.filter((x) => x !== s) })} />
              <span className="truncate">{s}</span>
            </label>
          ))}
        </>
      )}
      <p className={head}>Sorting</p>
      <label className={label}>
        <input type="checkbox" checked={settings.classify !== false} onChange={() => onChange({ ...settings, classify: settings.classify === false })} />
        Sort new mail and chats with AI
      </label>
      <label className={label}>
        Daily limit
        <input
          type="number"
          min={0}
          max={DAILY_CAP_MAX}
          defaultValue={settings.dailyCap}
          onBlur={(e) => {
            const n = Math.floor(Number(e.target.value));
            if (Number.isFinite(n) && n !== settings.dailyCap) onChange({ ...settings, dailyCap: Math.max(0, Math.min(DAILY_CAP_MAX, n)) });
          }}
          data-testid="actions-daily-limit"
          className="w-20 rounded border border-hairline bg-background px-1.5 py-0.5 text-xs tabular-nums"
        />
        <span className="text-muted-foreground">AI checks a day</span>
      </label>
    </div>
  );
}
