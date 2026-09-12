// WHAT:       The two journey Android home widgets (PRIORITIES, SCHEDULE) as internal Huddle
//             widgets: renderable as a card in the chat stream, docked in Iris Chase's 1:1, and
//             available as full-page side-menu views.
// WHY:        journey's home widgets are the owner's daily driver for priorities + schedule and were
//             unreachable from Huddle chat. Spec = docs/widgets/spec-priorities-widget.jpg and
//             docs/widgets/spec-schedule-widget.jpg.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-C-widget-ui.md records the spec read, the adaptations for the narrow chat
//             column, the docking mechanism, and the Lane-B data dependency.
//
// EXTENDS THE CHECKLIST WIDGET, does not parallel it. Same three rules, for the same reasons:
//   1. The message payload is a SNAPSHOT of server truth; mutable per-row state lives in the store's
//      `checklistState`, keyed by journey taskId OUTSIDE the message, so a re-delivered turn can never
//      revert an action the user just took.
//   2. Every control is an OPTIMISTIC write with a VISIBLE ROLLBACK on failure
//      (setChecklistRow / rollbackChecklistRow), one in-flight write per row.
//   3. Every write goes through `updateBoardTask` -- the same server fn BoardView's applyMove and the
//      chat checklist call -- so there is no second writer into journey.
// NO ROW CAP anywhere, deliberately: the owner rejected exactly that on the checklist ("it should
// include all that comes back from the query no matter how long that is"). Sections scroll instead.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mic,
  Pause,
  Play,
  Send,
  Settings,
  Star,
  Triangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import type {
  PrioritiesPayload,
  SchedulePayload,
  WidgetTaskRow,
  WidgetTopicNode,
} from "../data/seed";
import { getBoardTasks, updateBoardTask } from "../lib/tasks/board.functions";
import { useDictation } from "../hooks/useDictation";
import { useHuddleStore } from "../store";

/** The 1:1 huddle the widgets are docked in. Iris is agent `iris-chase`; `dm-<agentId>` is how
 *  data/seed.ts builds every 1:1 huddle id, so this is derived from that convention, not invented. */
export const WIDGET_DOCK_HUDDLE_ID = "dm-iris-chase";

const PARKING_LOT_TAG = "parking-lot";

/* ── The Today writer: ONE injection point ────────────────────────────────────────────────────────
 * `▲ Today` / `✓ Today` means "scheduled onto today" in journey. That is NOT a status and NOT a tag,
 * so `updateBoardTask` cannot express it -- it validates and forwards only
 * status/assigned_agent/category/tags/addTags/removeTags.
 * journey DOES have the right tools already (`schedule_task { task_id, date? }` and
 * `unschedule_task { task_id }` in execute-tool), but reaching them from the client needs a thin
 * client-callable server fn over `invokeJourneyTool`, and `lib/journey` + any new `.functions.ts`
 * are Lane B's files. So the control is built to spec and takes its writer from HERE.
 * While this is null the button renders DISABLED with an explanatory title rather than silently
 * no-op'ing or faking "today" with a tag that journey would not honour -- an inert control that looks
 * live is worse than one that is visibly not wired. Wiring Lane B's fn is a one-line change here. */
export type TodayWriter = (taskId: string, today: boolean) => Promise<{ ok: boolean; error?: string }>;
export const WIDGET_TODAY_WRITER: TodayWriter | null = null;
const TODAY_UNWIRED_TITLE =
  "Scheduling onto today isn't wired up yet (needs journey's schedule_task/unschedule_task exposed to the client).";

/* ── Category chips ──────────────────────────────────────────────────────────────────────────────
 * The spec colour-codes chips per category (Life = blue, Education = amber). Implemented as a
 * DETERMINISTIC hash of the category name to a hue rather than a lookup table, because a table only
 * covers the categories that happened to be in the screenshot and journey's categories are data the
 * user can add to -- the same reason routing is roster-driven instead of a per-agent list. Every
 * category gets a stable, distinct colour with zero per-category code, and the mix is against the
 * theme's own surface/foreground so it reads in dark mode too. */
function categoryChipStyle(category: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) % 360;
  return {
    backgroundColor: `oklch(0.95 0.05 ${h} / 0.55)`,
    color: `oklch(0.42 0.13 ${h})`,
  };
}

function CategoryChip({ category }: { category?: string }) {
  if (!category) return null;
  // journey stores categories upper-snake (LIFE, PROF_EDUCATION); the spec shows them title-cased.
  const label = category
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none"
      style={categoryChipStyle(category)}
      title={category}
    >
      {label}
    </span>
  );
}

/* ── Shared row plumbing ─────────────────────────────────────────────────────────────────────────
 * Lifted out of both widgets rather than duplicated: identical optimistic-write + rollback discipline,
 * identical one-write-per-row guard. `caller` threading matches the chat checklist exactly. */

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

function useCaller(): Caller {
  const { user } = useAuth();
  return useMemo(
    () =>
      user
        ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
        : undefined,
    [user],
  );
}

/** Optimistic write + rollback for one row, shared by every control in both widgets. Returns false
 *  when the write was refused up front (a write already in flight for this row). */
async function applyRowWrite(
  row: WidgetTaskRow,
  caller: Caller,
  patch: { status?: string; addTags?: string[]; removeTags?: string[] },
  opts: { nextPrev?: string; optimisticTags?: string[] } = {},
): Promise<boolean> {
  const store = useHuddleStore.getState();
  const before = store.checklistState[row.taskId] ?? { status: row.status, tags: row.tags };
  if (before.busy) return false; // one in-flight write per row; a double-tap must not race itself
  store.setChecklistRow(row.taskId, {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(opts.optimisticTags !== undefined ? { tags: opts.optimisticTags } : {}),
    busy: true,
    ...(opts.nextPrev !== undefined ? { prevStatus: opts.nextPrev } : {}),
  });
  try {
    const r = await updateBoardTask({ data: { caller, taskId: row.taskId, ...patch } });
    if (!r.ok) {
      // Roll back to exactly what it was, prevStatus included — a failed write must leave no trace,
      // or the next un-tick would restore a status that never took effect.
      store.rollbackChecklistRow(row.taskId, before);
      toast.error(r.error || "Couldn't update that task.");
      return false;
    }
    store.setChecklistRow(row.taskId, { busy: false });
    return true;
  } catch (err) {
    store.rollbackChecklistRow(row.taskId, before);
    toast.error(err instanceof Error ? err.message : "Couldn't update that task.");
    return false;
  }
}

/** The resolved display state for a row: the store overlay IS the display value; the snapshot only
 *  covers the first paint before the seed effect runs. That is what makes a stale snapshot harmless. */
function useRowState(row: WidgetTaskRow) {
  const live = useHuddleStore((s) => s.checklistState[row.taskId]);
  return {
    status: live?.status ?? row.status,
    tags: live?.tags ?? row.tags,
    busy: live?.busy ?? false,
    prevStatus: live?.prevStatus,
    // `today` is only meaningful once somebody supplied it; `?? row.today` keeps the snapshot as the
    // first-paint value without inventing `false` for a row whose today-ness was never read.
    today: live?.today ?? row.today,
  };
}

/** Seed + reconcile the shared row map for a set of rows. Two stages, exactly as ChecklistCard does:
 *  seed from the snapshot so the widget paints instantly (never overwriting a row the user acted on),
 *  then reconcile status/tags against server truth because `checklistState` is NOT persisted while
 *  `messages` is — after a reload a snapshot would otherwise show hours-stale status. */
function useSeededRows(rows: WidgetTaskRow[], caller: Caller) {
  const seedChecklistRows = useHuddleStore((s) => s.seedChecklistRows);
  // Identity over ids+today, so re-running is driven by the row SET rather than by array identity
  // (a new array every render would re-fire the reconcile read on every paint).
  const key = useMemo(() => rows.map((r) => `${r.taskId}:${r.today ?? ""}`).join(","), [rows]);

  useEffect(() => {
    if (rows.length) seedChecklistRows(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, seedChecklistRows]);

  useEffect(() => {
    if (!key || !caller?.entra_email) return;
    let cancelled = false;
    const wanted = new Set(key.split(",").map((k) => k.split(":")[0]));
    void getBoardTasks({ data: { caller } })
      .then((res) => {
        if (cancelled) return;
        const fresh = res.tasks
          .filter((t) => wanted.has(t.id))
          .map((t) => ({
            taskId: t.id,
            status: (t.status ?? "BACKLOG").toUpperCase(),
            tags: t.tags ?? [],
          }));
        if (fresh.length) useHuddleStore.getState().refreshChecklistRows(fresh);
      })
      // A failed refresh is not an error the user needs: the snapshot is still a truthful record of
      // what the server said. Degrade to it silently rather than throwing a toast at an idle screen.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, caller]);
}

/* ── Controls ────────────────────────────────────────────────────────────────────────────────────
 * Every control is padded to a 44px touch target (min-h-11 / size-11) with negative margins keeping
 * the row visually compact — the same technique and the same reason as the chat checklist: a 16-20px
 * tap target fails on a phone, which is where a chat widget is most used. */

const CTRL_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-semibold " +
  "leading-none transition disabled:opacity-50 disabled:cursor-not-allowed";

function TodayButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { today, busy } = useRowState(row);
  const [pending, setPending] = useState(false);
  const writer = WIDGET_TODAY_WRITER;
  const on = today === true;

  async function toggle() {
    if (!writer) return;
    const store = useHuddleStore.getState();
    const before = store.checklistState[row.taskId] ?? { status: row.status, tags: row.tags };
    if (before.busy || pending) return;
    setPending(true);
    store.setChecklistRow(row.taskId, { today: !on, busy: true });
    try {
      const r = await writer(row.taskId, !on);
      if (!r.ok) {
        store.rollbackChecklistRow(row.taskId, before);
        toast.error(r.error || "Couldn't change that task's day.");
        return;
      }
      store.setChecklistRow(row.taskId, { busy: false });
    } catch (err) {
      store.rollbackChecklistRow(row.taskId, before);
      toast.error(err instanceof Error ? err.message : "Couldn't change that task's day.");
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      disabled={!writer || busy || !caller?.entra_email}
      onClick={toggle}
      aria-pressed={on}
      title={writer ? undefined : TODAY_UNWIRED_TITLE}
      aria-label={on ? `"${row.title}" is on today — remove it` : `Put "${row.title}" on today`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 px-2")}
      style={
        on
          ? { backgroundColor: "var(--success)", color: "var(--success-foreground)" }
          : { backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }
      }
    >
      {pending || busy ? (
        <Loader2 size={10} className="animate-spin" aria-hidden />
      ) : on ? (
        <Check size={10} strokeWidth={3} aria-hidden />
      ) : (
        // The spec's ▲ glyph. `Triangle` filled at this size reads as the same mark and needs no font.
        <Triangle size={9} strokeWidth={0} className="fill-current" aria-hidden />
      )}
      Today
    </button>
  );
}

/** ▶ start → DOING. Clearing parking-lot alongside it, for the checklist's reason: parking-lot is a
 *  tag, and leaving it on would keep the row excluded from auto-work while it looks active. */
function StartButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status, tags, busy } = useRowState(row);
  const doing = status === "DOING";
  return (
    <button
      type="button"
      disabled={busy || doing || !caller?.entra_email}
      onClick={() =>
        void applyRowWrite(
          row,
          caller,
          { status: "DOING", removeTags: [PARKING_LOT_TAG] },
          { nextPrev: status, optimisticTags: tags.filter((t) => t !== PARKING_LOT_TAG) },
        )
      }
      aria-label={doing ? `"${row.title}" is already in progress` : `Start "${row.title}"`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{ backgroundColor: "var(--success)", color: "var(--success-foreground)", opacity: doing ? 0.45 : undefined }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} className="fill-current" aria-hidden />}
    </button>
  );
}

/** ✓ done → DONE, and un-ticking restores where the row WAS (prevStatus), never a blanket BACKLOG —
 *  a mis-tap on a DOING task must not silently demote it out of the active lane. */
function DoneButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status, busy, prevStatus } = useRowState(row);
  const done = status === "DONE";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      disabled={busy || !caller?.entra_email}
      onClick={() =>
        void applyRowWrite(
          row,
          caller,
          { status: done ? (prevStatus ?? "BACKLOG") : "DONE" },
          done ? {} : { nextPrev: status },
        )
      }
      aria-label={done ? `Mark "${row.title}" not done` : `Mark "${row.title}" done`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{
        backgroundColor: done ? "var(--success)" : "color-mix(in oklch, var(--success) 55%, var(--surface))",
        color: "var(--success-foreground)",
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={14} strokeWidth={3} aria-hidden />}
    </button>
  );
}

/** ⏸ pause → BACKLOG. The spec's orange control; `--warning` is the theme's orange and flips with it. */
function PauseButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status, busy } = useRowState(row);
  return (
    <button
      type="button"
      disabled={busy || !caller?.entra_email}
      onClick={() => void applyRowWrite(row, caller, { status: "BACKLOG" }, { nextPrev: status })}
      aria-label={`Pause "${row.title}" back to the backlog`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{ backgroundColor: "var(--warning)", color: "var(--warning-foreground)" }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Pause size={13} className="fill-current" aria-hidden />}
    </button>
  );
}

/* ── Compose row ─────────────────────────────────────────────────────────────────────────────────
 * The spec's "Add a priority…" / "What's next…" pill with mic / send / mic.
 *
 * ADAPTED (documented in docs/LANE-C-widget-ui.md): ONE mic, not two. The Android widget's two mics
 * are the same affordance (system voice-input beside the app's), and duplicate chrome is exactly what
 * a narrow chat column cannot spare.
 *
 * WHERE SEND GOES: there is no client-callable task-CREATE server fn in this repo (board.functions
 * exposes only getBoardTasks/updateBoardTask), and adding one would be a new `.functions.ts` module
 * — Lane B's file. So rather than stand up a second task writer, send hands the text to the EXISTING
 * path that already creates tasks: it prefills the chat composer (the same `draftPrefill` bridge the
 * checklist's Revise button uses) in Iris's 1:1, where `create_huddle_task`/`quick_create_task` do
 * the create. One writer, no new plumbing, and the user sees what will be sent before it is sent. */
function WidgetComposeRow({ placeholder, prefix }: { placeholder: string; prefix?: string }) {
  const [text, setText] = useState("");
  const dictation = useDictation();
  const view = useHuddleStore((s) => s.view);
  const activeHuddleId = useHuddleStore((s) => s.activeHuddleId);
  const setActive = useHuddleStore((s) => s.setActive);
  const setDraftPrefill = useHuddleStore((s) => s.setDraftPrefill);

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    // Only relocate when there is no composer on screen to receive the text (a full-page widget view,
    // or a huddle that isn't the dock). Typing into the widget while already in a chat should not
    // yank the user out of the conversation they are in.
    if (view !== "huddle" || activeHuddleId !== WIDGET_DOCK_HUDDLE_ID) setActive(WIDGET_DOCK_HUDDLE_ID);
    setDraftPrefill(prefix ? `${prefix}${t}` : t);
    setText("");
  }, [text, view, activeHuddleId, setActive, setDraftPrefill, prefix]);

  async function dictate() {
    if (dictation.recording) {
      const t = await dictation.stop();
      if (t) setText((prev) => (prev ? `${prev} ${t}` : t));
      else if (dictation.error) toast.error(dictation.error);
    } else {
      const err = await dictation.start();
      if (err) toast.error(err);
    }
  }

  return (
    <div className="flex items-center gap-1 rounded-full bg-muted px-3 py-1">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
      {dictation.supported && (
        <button
          type="button"
          onClick={dictate}
          disabled={dictation.transcribing}
          aria-label={dictation.recording ? "Stop dictation" : "Dictate"}
          className="-my-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          style={
            dictation.recording
              ? {
                  color: "var(--destructive)",
                  boxShadow: `0 0 0 ${Math.round(1 + dictation.level * 5)}px color-mix(in oklch, var(--destructive) 22%, transparent)`,
                }
              : undefined
          }
        >
          {dictation.transcribing ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}
        </button>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        aria-label="Send to Iris"
        className="-my-2 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40"
        style={{ color: "var(--ai)" }}
      >
        <Send size={15} className="fill-current" />
      </button>
    </div>
  );
}

/* ── Section chrome ──────────────────────────────────────────────────────────────────────────────
 * The cream/ivory band from both screenshots, expressed against the THEME's own warning hue rather
 * than a hardcoded off-white — a literal #FFFCF0 would be invisible in light mode's white surface and
 * glaring in dark mode. */
const BAND_STYLE: React.CSSProperties = {
  backgroundColor: "color-mix(in oklch, var(--warning) 9%, var(--surface))",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** Rows scroll rather than truncate — see the NO ROW CAP note at the top of this file. The cap here
 *  is on HEIGHT (a viewport fraction), never on row count, so every row the query returned is
 *  reachable. In a full-page view there is no reason to constrain it at all. */
function ScrollBand({
  children,
  band,
  full,
}: {
  children: React.ReactNode;
  band?: boolean;
  full?: boolean;
}) {
  return (
    <div
      className={cn("overflow-y-auto", full ? "" : "max-h-[min(22rem,45vh)]")}
      style={band ? BAND_STYLE : undefined}
    >
      {children}
    </div>
  );
}

/* ── PRIORITIES ─────────────────────────────────────────────────────────────────────────────────── */

function PriorityRow({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status } = useRowState(row);
  const done = status === "DONE";
  return (
    <li className="flex items-center gap-2 border-b border-hairline px-3 py-2 last:border-b-0">
      <span
        className={cn("min-w-0 flex-1 truncate text-[13px] leading-snug", done ? "text-muted-foreground line-through" : "text-foreground")}
        title={row.title}
      >
        {row.title}
      </span>
      <CategoryChip category={row.category} />
      <TodayButton row={row} caller={caller} />
    </li>
  );
}

/** One top-level topic and its sub-topics. Expansion is LOCAL component state, not store state: it is
 *  per-view chrome with no consequence if it resets, and putting it in the store would make two
 *  mounted copies of the widget (chat card + docked) fight over one expanded set. */
function TopicRow({ node, depth }: { node: WidgetTopicNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0 && !!node.children?.length);
  const hasChildren = !!node.children?.length;
  // The coloured left rail in the spec, one hue per top-level topic. Same deterministic hash as the
  // category chips, so a topic and its category chip agree in colour for free.
  const rail = depth === 0 ? categoryChipStyle(node.label).color : undefined;
  return (
    <li>
      <div className="flex items-stretch">
        {depth === 0 && (
          <span aria-hidden className="mr-1.5 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: rail as string }} />
        )}
        <button
          type="button"
          disabled={!hasChildren}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={hasChildren ? open : undefined}
          className="-my-1.5 flex min-h-11 min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-3 text-left disabled:cursor-default"
          style={{ paddingLeft: `${depth * 0.875 + (depth === 0 ? 0 : 0.75)}rem` }}
        >
          <span className="w-3 shrink-0 text-muted-foreground">
            {hasChildren ? (
              open ? (
                <ChevronDown size={11} aria-hidden />
              ) : (
                <ChevronRight size={11} aria-hidden />
              )
            ) : null}
          </span>
          <span
            className={cn("min-w-0 flex-1 truncate text-[13px]", depth === 0 ? "text-foreground" : "text-foreground/85")}
            title={node.label}
          >
            {node.label}
          </span>
          {/* A topic with no open tasks renders BLANK, never "0" — matches the spec (Family, and
              several sub-topics, carry no number at all). */}
          {node.count ? (
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{node.count}</span>
          ) : null}
        </button>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children!.map((c) => (
            <TopicRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PrioritiesWidget({
  payload,
  full,
  onSettings,
}: {
  payload: PrioritiesPayload;
  full?: boolean;
  onSettings?: () => void;
}) {
  const caller = useCaller();
  useSeededRows(payload.rows, caller);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">
          {payload.title || "Priorities"}
        </span>
        <button
          type="button"
          onClick={onSettings}
          disabled={!onSettings}
          aria-label="Priorities settings"
          className="-my-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Settings size={15} />
        </button>
      </div>

      <div className="px-3 py-2">
        <WidgetComposeRow placeholder="Add a priority…" prefix="Add a priority: " />
      </div>

      {payload.rows.length > 0 ? (
        <ScrollBand band full={full}>
          <ul>
            {payload.rows.map((row) => (
              <PriorityRow key={row.taskId} row={row} caller={caller} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <div style={BAND_STYLE} className="px-3 py-3 text-[12px] text-muted-foreground">
          No priorities right now.
        </div>
      )}

      {/* The topic tree. When journey's `get_task_topics` is unavailable this renders a LABELLED
          empty state rather than an empty or half-built tree: the rest of the widget has to stay
          usable and honest before that deploy lands, and "no topics" and "couldn't read topics" are
          different facts the user is entitled to tell apart. */}
      {payload.topicsUnavailable ? (
        <div className="border-t border-hairline px-3 py-3 text-[12px] text-muted-foreground">
          Topic breakdown isn’t available yet — journey’s topic list isn’t deployed. Everything above
          is live.
        </div>
      ) : payload.topics.length > 0 ? (
        <ScrollBand full={full}>
          <ul className="border-t border-hairline py-1">
            {payload.topics.map((t) => (
              <TopicRow key={t.id} node={t} depth={0} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <div className="border-t border-hairline px-3 py-3 text-[12px] text-muted-foreground">
          No topics yet.
        </div>
      )}
    </div>
  );
}

/* ── SCHEDULE ───────────────────────────────────────────────────────────────────────────────────── */

function ScheduleRowItem({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status } = useRowState(row);
  const done = status === "DONE";
  return (
    <li className="flex items-center gap-2 border-b border-hairline px-3 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {row.time && (
          <span className="shrink-0 text-[12px] font-semibold tabular-nums text-foreground">{row.time}</span>
        )}
        <span
          className={cn("min-w-0 truncate text-[13px] leading-snug", done ? "text-muted-foreground line-through" : "text-foreground")}
          title={row.title}
        >
          {row.title}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <StartButton row={row} caller={caller} />
        <DoneButton row={row} caller={caller} />
      </div>
    </li>
  );
}

function UpNextRowItem({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <Star size={11} className="shrink-0 fill-current" style={{ color: "var(--warning)" }} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-foreground" title={row.title}>
        {row.title}
      </span>
      <TodayButton row={row} caller={caller} />
    </li>
  );
}

export function ScheduleWidget({ payload, full }: { payload: SchedulePayload; full?: boolean }) {
  const caller = useCaller();
  // ONE seed/reconcile pass over every row in the widget, so a task appearing in both "today" and
  // "up next" is tracked once and stays consistent between the two sections.
  const allRows = useMemo(
    () => [...payload.todays, ...payload.doing, ...payload.upNext],
    [payload.todays, payload.doing, payload.upNext],
  );
  useSeededRows(allRows, caller);
  const doing = payload.doing[0];

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft">
      <div className="px-3 py-2">
        <WidgetComposeRow placeholder="What's next…" />
      </div>

      <SectionLabel>Today’s schedule</SectionLabel>
      {payload.todays.length > 0 ? (
        <ScrollBand full={full}>
          <ul className="border-t border-hairline">
            {payload.todays.map((row) => (
              <ScheduleRowItem key={row.taskId} row={row} caller={caller} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <div className="border-t border-hairline px-3 py-2.5 text-[12px] text-muted-foreground">
          Nothing scheduled for today.
        </div>
      )}

      <SectionLabel>Currently doing</SectionLabel>
      <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
        {/* The spec puts this in BOLD and spells the empty state out — it is the one line the user
            checks at a glance, so an empty section here would read as a rendering failure. */}
        <span
          className={cn("min-w-0 flex-1 truncate text-[13px] font-bold", doing ? "text-foreground" : "text-foreground")}
          title={doing?.title}
        >
          {doing ? doing.title : "Nothing in progress"}
        </span>
        {doing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <DoneButton row={doing} caller={caller} />
            <PauseButton row={doing} caller={caller} />
          </div>
        )}
      </div>

      <SectionLabel>Up next</SectionLabel>
      <div style={BAND_STYLE}>
        <div className="flex items-center gap-1.5 px-3 pt-2">
          <Star size={11} className="fill-current" style={{ color: "var(--warning)" }} aria-hidden />
          <span className="text-[12px] font-bold" style={{ color: "var(--warning-foreground)" }}>
            {payload.upNextLabel || "This Week"}
          </span>
        </div>
        {payload.upNext.length > 0 ? (
          <ScrollBand full={full}>
            <ul className="pb-1">
              {payload.upNext.map((row) => (
                <UpNextRowItem key={row.taskId} row={row} caller={caller} />
              ))}
            </ul>
          </ScrollBand>
        ) : (
          <div className="px-3 pb-3 pt-1 text-[12px] text-muted-foreground">Nothing queued up.</div>
        )}
      </div>
    </div>
  );
}

/* ── Live data ───────────────────────────────────────────────────────────────────────────────────
 * A widget rendered from a chat MESSAGE carries its own payload. The DOCKED copy in Iris's 1:1 and
 * the two full-page VIEWS have no message, so they need a live read.
 *
 * Lane B's dedicated read fns did not exist when this was written (docs/LANE-B-widget-data.md had no
 * types and an unticked implementation list), so this derives what it can from the server fn that
 * DOES exist — `getBoardTasks` — and is explicit about what that cannot cover. It does NOT fabricate:
 * per CLAUDE.md, an absent dependency is derived from the real distinct values present, or degraded
 * to a labelled empty state; never seeded with invented rows.
 *
 * What `BoardTaskRow` gives us: id, title, status, category, tags, is_priority, priority_rank,
 * due_date. What it does NOT give us: `start_time` / `is_scheduled` — so:
 *   • SCHEDULE "Today's schedule" (which is defined by those columns) stays EMPTY here and says so.
 *   • `today` is left UNDEFINED rather than false, so the Today control never claims a task is off
 *     today on the strength of a column we never read.
 *   • "Currently doing" and "Up next" ARE real: they are status reads.
 *   • PRIORITIES topics are derived from the real distinct categories with real open counts; sub-topics
 *     are journey's `get_task_topics` and are genuinely absent, so no sub-topic is invented.
 * Swapping in Lane B's reads replaces this one hook and nothing else. */

type LiveWidgetData = {
  loading: boolean;
  priorities: PrioritiesPayload;
  schedule: SchedulePayload;
};

const EMPTY_PRIORITIES: PrioritiesPayload = { rows: [], topics: [] };
const EMPTY_SCHEDULE: SchedulePayload = { todays: [], doing: [], upNext: [] };

function useLiveWidgetData(): LiveWidgetData {
  const caller = useCaller();
  const [state, setState] = useState<LiveWidgetData>({
    loading: true,
    priorities: EMPTY_PRIORITIES,
    schedule: EMPTY_SCHEDULE,
  });

  useEffect(() => {
    if (!caller?.entra_email) {
      setState({ loading: false, priorities: EMPTY_PRIORITIES, schedule: EMPTY_SCHEDULE });
      return;
    }
    let cancelled = false;
    void getBoardTasks({ data: { caller } })
      .then((res) => {
        if (cancelled) return;
        const rows = res.tasks.map<WidgetTaskRow>((t) => ({
          taskId: t.id,
          title: t.title,
          status: (t.status ?? "BACKLOG").toUpperCase(),
          tags: t.tags ?? [],
          ...(t.category ? { category: t.category } : {}),
        }));
        const open = rows.filter((r) => r.status !== "DONE");
        const rank = new Map(res.tasks.map((t) => [t.id, t.priority_rank ?? Number.MAX_SAFE_INTEGER]));
        const byRank = (a: WidgetTaskRow, b: WidgetTaskRow) =>
          (rank.get(a.taskId) ?? 0) - (rank.get(b.taskId) ?? 0);
        const flagged = new Set(res.tasks.filter((t) => t.is_priority).map((t) => t.id));

        // PRIORITIES band: what the user has actually flagged or queued. Falls back to the whole open
        // set when nothing is flagged, so the widget is never mysteriously empty on a real board.
        const banded = open.filter((r) => flagged.has(r.taskId) || r.status === "UP_NEXT" || r.status === "READY");
        const priorityRows = (banded.length ? banded : open).slice().sort(byRank);

        // Topic tree: real categories, real open counts, no invented sub-topics.
        const counts = new Map<string, number>();
        for (const r of open) {
          const c = r.category?.trim();
          if (!c) continue;
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        const topics = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map<WidgetTopicNode>(([label, count]) => ({ id: `cat-${label}`, label, count }));

        setState({
          loading: false,
          priorities: {
            rows: priorityRows,
            topics,
            // Sub-topics come from journey's get_task_topics, which is not reachable from here. Say so
            // only when we have nothing at all to show; otherwise the real category counts stand.
            ...(topics.length ? {} : { topicsUnavailable: true }),
          },
          schedule: {
            // Deliberately empty: "today's schedule" is start_time/is_scheduled, columns this read
            // does not return. An empty section that says so beats a wrong one that looks right.
            todays: [],
            doing: open.filter((r) => r.status === "DOING").slice().sort(byRank),
            upNext: open
              .filter((r) => r.status === "UP_NEXT" || r.status === "READY" || flagged.has(r.taskId))
              .slice()
              .sort(byRank),
          },
        });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, priorities: EMPTY_PRIORITIES, schedule: EMPTY_SCHEDULE });
      });
    return () => {
      cancelled = true;
    };
  }, [caller]);

  return state;
}

function WidgetLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-4 text-[12px] text-muted-foreground shadow-soft">
      <Loader2 size={13} className="animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/* ── Docked pair (Iris's 1:1) ────────────────────────────────────────────────────────────────────
 * "Docked" = persistently present in that huddle, NOT a message. Rendered by Transcript above the
 * message list, so it is there whether or not a tool ever fired, and — critically — it is NOT in
 * `messages`, which is what `history` (and therefore the turn payload and the unread watermark) is
 * built from. A pinned MESSAGE would have leaked a widget into every turn's model context and into
 * the transcript the user scrolls; this cannot.
 * Collapsed by default so it never buries the conversation; the toggle is device-local chrome. */
export function DockedJourneyWidgets() {
  const { loading, priorities, schedule } = useLiveWidgetData();
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-hairline bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
        <span className="text-[12px] font-semibold text-foreground">Priorities &amp; schedule</span>
        <span className="text-[11px] text-muted-foreground">· pinned here</span>
      </button>
      {open && (
        <div className="grid gap-3 px-2 pb-2 lg:grid-cols-2">
          {loading ? (
            <WidgetLoading label="Loading your priorities…" />
          ) : (
            <>
              <PrioritiesWidget payload={priorities} />
              <ScheduleWidget payload={schedule} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Full-page views (side menu) ─────────────────────────────────────────────────────────────────── */

function WidgetPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="border-b border-hairline bg-surface px-3 py-2.5 sm:px-6">
        <h1 className="text-sm font-semibold text-foreground">{title}</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto max-w-3xl">{children}</div>
      </div>
    </section>
  );
}

export function PrioritiesView() {
  const { loading, priorities } = useLiveWidgetData();
  return (
    <WidgetPage title="Priorities">
      {loading ? <WidgetLoading label="Loading your priorities…" /> : <PrioritiesWidget payload={priorities} full />}
    </WidgetPage>
  );
}

export function ScheduleView() {
  const { loading, schedule } = useLiveWidgetData();
  return (
    <WidgetPage title="Schedule">
      {loading ? <WidgetLoading label="Loading your schedule…" /> : <ScheduleWidget payload={schedule} full />}
    </WidgetPage>
  );
}
