// WHAT:       The two journey Android home widgets (PRIORITIES, SCHEDULE) as internal Huddle
//             widgets: renderable as a card in the chat stream, docked in Iris Chase's 1:1, and
//             available as full-page side-menu views.
// WHY:        journey's home widgets are the owner's daily driver for priorities + schedule and were
//             unreachable from Huddle chat. Spec = docs/widgets/spec-priorities-widget.jpg and
//             docs/widgets/spec-schedule-widget.jpg.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-C-widget-ui.md records the spec read, the narrow-column adaptations, the
//             docking mechanism and the reconciliation onto Lane B's contract
//             (docs/LANE-B-widget-data.md + lib/tasks/widgets.server.ts, read this session).
//
// DATA AND WRITES ARE ALL LANE B'S (lib/tasks/widgets.functions.ts). This file adds NO query and NO
// writer of its own:
//   getScheduleWidget   -> ScheduleWidgetData   { todaySchedule, currentlyDoing, upNext, ... }
//   getPrioritiesWidget -> PrioritiesWidgetData { band, topics: TopicTreeResult, ... }
//   updateWidgetTask    -> WidgetActionResult   for all five buttons (start/done/pause/today/untoday)
// None of the three ever throws; every failure is a normal return with ok:false + error, so the
// widget always renders something truthful.
//
// EXTENDS THE CHECKLIST WIDGET, does not parallel it. Same three rules, for the same reasons:
//   1. A widget on a MESSAGE carries a SNAPSHOT; mutable per-row state lives in the store's
//      `checklistState`, keyed by journey taskId OUTSIDE the message, so a re-delivered turn can
//      never revert an action the user just took.
//   2. Every control is an OPTIMISTIC write with a VISIBLE ROLLBACK on failure
//      (setChecklistRow / rollbackChecklistRow), one in-flight write per row.
//   3. One writer into journey. The mirror behind every read is eventually consistent (~1-3s), which
//      is why the optimistic overlay — not a refetch — is what the user sees immediately.
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
  PrioritiesWidgetData,
  ScheduleWidgetData,
  TopicNode,
  TopicTreeResult,
  WidgetTaskAction,
  WidgetTaskRow,
} from "../lib/tasks/widgets.server";
import { categoryHue } from "../lib/tasks/widget-colors";
import {
  getPrioritiesWidget,
  getScheduleWidget,
  updateWidgetTask,
} from "../lib/tasks/widgets.functions";
import { useDictation } from "../hooks/useDictation";
import { useHuddleStore } from "../store";

/** The 1:1 huddle the widgets are docked in. Iris is agent `iris-chase`; `dm-<agentId>` is how
 *  data/seed.ts builds every 1:1 huddle id, so this follows that convention rather than inventing one. */
export const WIDGET_DOCK_HUDDLE_ID = "dm-iris-chase";

/** The viewer's IANA zone. Lane B asks the client to pass this: `resolveTimeZone` prefers the stored
 *  profile zone and falls back to THIS, then UTC — so passing it is what makes "today" correct for a
 *  caller with no stored profile zone. Resolved once; it does not change mid-session. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
const TIME_ZONE = browserTimeZone();

/** `"10:00AM"` — the spec's compact form, formatted CLIENT-side because Lane B returns raw ISO
 *  (`startTime`) on purpose: the widget renders in the viewer's locale, so the server never
 *  pre-formats a clock time. The zone is the same one passed to the read, so the label and the
 *  server's own "today" boundary agree. */
function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      // "10:00 AM" -> "10:00AM": the screenshots run the meridiem onto the time, which buys a
      // character of title width on every row.
      .replace(/\s?(AM|PM)$/i, (_m, p: string) => p.toUpperCase());
  } catch {
    return null;
  }
}

/* ── Category chips ──────────────────────────────────────────────────────────────────────────────
 * The spec colour-codes chips per category (Life = blue, Education = amber). `categoryHue` lives in
 * `lib/tasks/widget-colors.ts` — a SEEDED table for journey's four known categories (so the spec's
 * colours are actually delivered and no two of them collide) with the original hash kept as the
 * fallback for any category the user adds, which is what keeps this data-driven rather than a
 * per-category list. A bare hash put LIFE and EDUCATION 20 degrees apart — two near-identical greens
 * for the pair the spec makes the most distinct (VERIFY-journey-widgets-2.md N-5). */

function CategoryChip({ category }: { category: string | null }) {
  if (!category) return null;
  const h = categoryHue(category);
  // journey stores categories upper-snake (LIFE, PROF_EDUCATION); the spec shows them title-cased.
  const label = category
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none"
      style={{ backgroundColor: `oklch(0.95 0.05 ${h} / 0.55)`, color: `oklch(0.42 0.13 ${h})` }}
      title={category}
    >
      {label}
    </span>
  );
}

/* ── Shared row plumbing ───────────────────────────────────────────────────────────────────────── */

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

/** Lane B returns `status: string | null`; the store map and every comparison here want a plain
 *  upper-case string, so normalize in ONE place rather than at each use site. */
function rowStatus(row: WidgetTaskRow): string {
  return (row.status ?? "BACKLOG").toUpperCase();
}

/** The resolved display state for a row: the store overlay IS the display value; the payload only
 *  covers the first paint before the seed effect runs. That is what makes a stale snapshot harmless,
 *  and it is also what covers the mirror's ~1-3s lag after a write — the overlay holds the new value
 *  while journey → pg_net → webhook → mirror catches up. */
function useRowState(row: WidgetTaskRow) {
  const live = useHuddleStore((s) => s.checklistState[row.id]);
  return {
    status: live?.status ?? rowStatus(row),
    tags: live?.tags ?? row.tags,
    busy: live?.busy ?? false,
    prevStatus: live?.prevStatus,
    today: live?.today ?? row.isToday,
  };
}

/** One optimistic write, shared by all five buttons. Rolls the row back VISIBLY on failure.
 *  `optimisticStatus` is what to show immediately; `undefined` means this action does not change the
 *  status (the Today toggle), so only `today` moves. */
async function runAction(
  row: WidgetTaskRow,
  caller: Caller,
  action: WidgetTaskAction,
  optimistic: { status?: string; today?: boolean; prevStatus?: string },
): Promise<void> {
  const store = useHuddleStore.getState();
  const tracked = store.checklistState[row.id];
  const before = tracked ?? { status: rowStatus(row), tags: row.tags, today: row.isToday };
  if (before.busy) return; // one in-flight write per row; a double-tap must not race itself
  // THE GUARD ABOVE IS INOPERATIVE UNLESS THE ROW IS IN THE MAP. `setChecklistRow` opens with
  // `if (!cur) return {};` (store.ts) — a silent no-op for an untracked row — so `busy: true` was
  // never recorded, a second tap also passed the guard, and two concurrent writes reached journey
  // for the same task. The window is real: a tap between mount and the seed effect flushing.
  // Seeding first makes the row exist, so the optimistic paint and the busy flag both land.
  // (VERIFY-journey-widgets-2.md N-9. `seedChecklistRows` is skip-if-present, so this cannot stomp
  // a row that IS tracked — it is a no-op in the common case.)
  if (!tracked) {
    store.seedChecklistRows([
      {
        taskId: row.id,
        status: before.status,
        tags: before.tags,
        ...(before.today !== undefined ? { today: before.today } : {}),
      },
    ]);
  }
  store.setChecklistRow(row.id, {
    ...(optimistic.status !== undefined ? { status: optimistic.status } : {}),
    ...(optimistic.today !== undefined ? { today: optimistic.today } : {}),
    ...(optimistic.prevStatus !== undefined ? { prevStatus: optimistic.prevStatus } : {}),
    busy: true,
  });
  try {
    const r = await updateWidgetTask({ data: { caller, taskId: row.id, action, timeZone: TIME_ZONE } });
    if (!r.ok) {
      // Roll back to exactly what it was, prevStatus included — a failed write must leave no trace,
      // or the next un-tick would restore a status that never took effect.
      store.rollbackChecklistRow(row.id, before);
      toast.error(r.error || "Couldn't update that task.");
      return;
    }
    // `r.status` is journey's OWN value for start/done/pause (absent for today/untoday), so prefer it
    // over the status we guessed — if journey normalized it differently, the row now shows the truth.
    store.setChecklistRow(row.id, { busy: false, ...(r.status ? { status: r.status.toUpperCase() } : {}) });
  } catch (err) {
    // updateWidgetTask is documented never to throw; this covers a transport failure before it runs.
    store.rollbackChecklistRow(row.id, before);
    toast.error(err instanceof Error ? err.message : "Couldn't update that task.");
  }
}

/** Populate the shared row map from a payload, in the SAME two stages the chat checklist uses
 *  (HuddleView.tsx: `seedChecklistRows` from the snapshot for an instant paint, then
 *  `refreshChecklistRows` with server truth).
 *
 *  WHY TWO STAGES AND NOT ONE SEED. `seedChecklistRows` skips any row it already tracks, so the
 *  FIRST payload to reach the map wins permanently. An in-chat card renders its frozen snapshot
 *  SYNCHRONOUSLY on mount; the docked and full-page copies read Lane B asynchronously and seed
 *  hundreds of ms later, by which time every row they share with the stale card is skipped. Both
 *  surfaces then render the stale value, because `useRowState` prefers the map. So the LIVE
 *  surfaces must overwrite, not seed.
 *
 *  THE HAZARD THAT USED TO JUSTIFY SEEDING ONLY is already guarded inside the function we now call:
 *  a refetch right after a write would hand back the PRE-write value (~1-3s mirror propagation) and
 *  visibly undo the user's tap — and `refreshChecklistRows` (store.ts) skips any row with
 *  `busy: true` for exactly that reason. The optimistic overlay still covers the write window.
 *
 *  @param live `true` for a surface whose rows came from a Lane-B read this mount (docked /
 *  full-page). A message snapshot passes nothing and keeps seed-only semantics, so a re-rendered
 *  old card can never stomp a newer value. */
function useSeededRows(rows: WidgetTaskRow[], live?: boolean) {
  const seedChecklistRows = useHuddleStore((s) => s.seedChecklistRows);
  const refreshChecklistRows = useHuddleStore((s) => s.refreshChecklistRows);
  const key = useMemo(() => rows.map((r) => `${r.id}:${r.isToday ? 1 : 0}`).join(","), [rows]);
  useEffect(() => {
    if (!rows.length) return;
    const mapped = rows.map((r) => ({ taskId: r.id, status: rowStatus(r), tags: r.tags, today: r.isToday }));
    if (live) refreshChecklistRows(mapped);
    else seedChecklistRows(mapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, seedChecklistRows, refreshChecklistRows]);
}

/* ── Controls ────────────────────────────────────────────────────────────────────────────────────
 * Every control is padded to a 44px touch target (min-h-11 / size-11) with negative margins keeping
 * the row visually compact — the same technique and the same reason as the chat checklist: a 16-20px
 * tap target fails on a phone, which is where a chat widget is most used. */

const CTRL_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-semibold " +
  "leading-none transition disabled:opacity-50 disabled:cursor-not-allowed";

/** `▲ Today` (grey, tap to put it on today) / `✓ Today` (green, already today). Writes through Lane
 *  B's `today`/`untoday` actions, which map to journey's `move_task_to_day` / `unschedule_task`. */
function TodayButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { today, busy } = useRowState(row);
  const on = today === true;
  return (
    <button
      type="button"
      disabled={busy || !caller?.entra_email}
      onClick={() =>
        void runAction(row, caller, on ? "untoday" : "today", { today: !on })
      }
      aria-pressed={on}
      aria-label={on ? `"${row.title}" is on today — take it off` : `Put "${row.title}" on today`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 px-2")}
      style={
        on
          ? { backgroundColor: "var(--success)", color: "var(--success-foreground)" }
          : { backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }
      }
    >
      {busy ? (
        <Loader2 size={10} className="animate-spin" aria-hidden />
      ) : on ? (
        <Check size={10} strokeWidth={3} aria-hidden />
      ) : (
        // The spec's ▲ glyph. `Triangle` filled at this size reads as the same mark, no font needed.
        <Triangle size={9} strokeWidth={0} className="fill-current" aria-hidden />
      )}
      Today
    </button>
  );
}

/** ▶ start → DOING. The spec pairs a LIGHTER teal ▶ beside a DARKER green ✓; both are expressed as
 *  mixes of the theme's own `--success` so the pair stays distinguishable in dark mode too, instead
 *  of the lighter one washing out to a pale blob on a dark card. */
function StartButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status, busy } = useRowState(row);
  const doing = status === "DOING";
  return (
    <button
      type="button"
      disabled={busy || doing || !caller?.entra_email}
      onClick={() => void runAction(row, caller, "start", { status: "DOING", prevStatus: status })}
      aria-label={doing ? `"${row.title}" is already in progress` : `Start "${row.title}"`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{
        backgroundColor: "color-mix(in oklch, var(--success) 72%, var(--surface))",
        color: "var(--success-foreground)",
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} className="fill-current" aria-hidden />}
    </button>
  );
}

/** ✓ done → DONE. Un-ticking restores where the row WAS (prevStatus), never a blanket BACKLOG — a
 *  mis-tap on a DOING task must not silently demote it out of the active lane. The row's title gains
 *  a strike-through, which is the visible state; the button itself stays full-strength, because
 *  dimming it as well made a completed row's only affordance look disabled. */
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
        done
          ? // "Un-done" restores where the row was: prevStatus DOING -> start, anything else ->
            // `reopen` (BACKLOG, tags untouched).
            // NOT `pause` — pause PARKS the task (adds the `parking-lot` tag that opts it out of all
            // automation), which is a far bigger side effect than un-ticking a checkbox asks for.
            // These two gestures shared one action until the pause-is-a-park fix; they must not again.
            void runAction(row, caller, prevStatus === "DOING" ? "start" : "reopen", {
              status: prevStatus === "DOING" ? "DOING" : "BACKLOG",
            })
          : void runAction(row, caller, "done", { status: "DONE", prevStatus: status })
      }
      aria-label={done ? `Mark "${row.title}" not done` : `Mark "${row.title}" done`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{ backgroundColor: "var(--success)", color: "var(--success-foreground)" }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={14} strokeWidth={3} aria-hidden />}
    </button>
  );
}

/** ⏸ pause PARKS: BACKLOG + the `parking-lot` tag (read from ACTION_STATUS / PARKING_LOT_TAG).
 *  This was UP_NEXT, which auto-work promotes straight back into DOING — pressing pause un-paused
 *  the task within hours. Parking is the only mapping that makes the button mean what it says.
 *  `--warning` is the theme's orange and flips with it. */
function PauseButton({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status, busy } = useRowState(row);
  return (
    <button
      type="button"
      disabled={busy || !caller?.entra_email}
      onClick={() => void runAction(row, caller, "pause", { status: "BACKLOG", prevStatus: status })}
      aria-label={`Pause "${row.title}"`}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={{ backgroundColor: "var(--warning)", color: "var(--warning-foreground)" }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Pause size={13} className="fill-current" aria-hidden />}
    </button>
  );
}

/** The ✓ / ⏸ pair the spec draws beside "Nothing in progress", with NOTHING to act on — so it is
 *  `disabled`, out of the tab order, and labelled for a screen reader as explicitly unavailable
 *  rather than silently inert. Same geometry and theme colours as the real buttons, so the empty row
 *  keeps the spec's shape (N-7). */
function EmptyDoingControl({ kind }: { kind: "done" | "pause" }) {
  const done = kind === "done";
  return (
    <button
      type="button"
      disabled
      tabIndex={-1}
      aria-label={done ? "Mark done — nothing in progress" : "Pause — nothing in progress"}
      className={cn(CTRL_BASE, "-my-2 min-h-11 w-10")}
      style={
        done
          ? { backgroundColor: "var(--success)", color: "var(--success-foreground)" }
          : { backgroundColor: "var(--warning)", color: "var(--warning-foreground)" }
      }
    >
      {done ? (
        <Check size={14} strokeWidth={3} aria-hidden />
      ) : (
        <Pause size={13} className="fill-current" aria-hidden />
      )}
    </button>
  );
}

/* ── Compose row ─────────────────────────────────────────────────────────────────────────────────
 * The spec's "Add a priority…" / "What's next…" pill with mic / send / mic.
 *
 * ADAPTED: ONE mic, not two. The Android widget's two mics are the same affordance (the system
 * voice-input beside the app's own), and duplicate chrome is exactly what a narrow chat column
 * cannot spare.
 *
 * WHERE SEND GOES: there is no task-CREATE server fn in this repo's client surface (Lane B's three
 * widget fns are two reads and a per-task action; board.functions exposes getBoardTasks and
 * updateBoardTask), and standing up another task writer would break the single-writer rule. So send
 * hands the text to the path that ALREADY creates tasks: it prefills the chat composer (the same
 * `draftPrefill` bridge the checklist's Revise button uses) in Iris's 1:1, where
 * `create_huddle_task`/`quick_create_task` do the create. The user also sees exactly what will be
 * sent before it is sent, which a blind widget-side create would not give them. */
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
    // or some other huddle). Typing into the docked widget while already in a chat should not yank
    // the user out of the conversation they are in.
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
 * than a hardcoded off-white — a literal #FFFCF0 would be near-invisible on light mode's white
 * surface and glaring in dark mode. */
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

function EmptyLine({ children, band }: { children: React.ReactNode; band?: boolean }) {
  return (
    <div className="px-3 py-2.5 text-[12px] text-muted-foreground" style={band ? BAND_STYLE : undefined}>
      {children}
    </div>
  );
}

/** Rows scroll rather than truncate — see the NO ROW CAP note at the top of this file. The cap is on
 *  HEIGHT (a viewport fraction), never on row count, so every row the query returned is reachable.
 *  In a full-page view there is no reason to constrain it at all. */
function ScrollBand({ children, band, full }: { children: React.ReactNode; band?: boolean; full?: boolean }) {
  return (
    <div className={cn("overflow-y-auto", full ? "" : "max-h-[min(22rem,45vh)]")} style={band ? BAND_STYLE : undefined}>
      {children}
    </div>
  );
}

/** The one place a failed Lane-B read is surfaced. `ok:false` always arrives with empty sections, so
 *  without this the widget would look like "you have nothing" when it actually means "we couldn't
 *  read it" — two different facts the user is entitled to tell apart. */
function ReadError({ error }: { error?: string }) {
  return (
    <div className="border-t border-hairline px-3 py-3 text-[12px] text-destructive">
      Couldn’t load this from your board{error ? ` — ${error}` : "."}
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

/** One topic and its sub-topics. Expansion is LOCAL component state, not store state: it is per-view
 *  chrome with no consequence if it resets, and putting it in the store would make two mounted copies
 *  of the widget (a chat card and the docked pair) fight over one expanded set. */
function TopicRow({ node, depth }: { node: TopicNode; depth: number }) {
  const hasChildren = node.children.length > 0;
  // Top level starts expanded (the spec shows Career open with its children visible); deeper levels
  // start closed so a large tree does not arrive as a wall of rows.
  const [open, setOpen] = useState(depth === 0 && hasChildren);
  // The coloured left rail, one hue per top-level topic — the SAME `categoryHue` the chips use, and
  // it normalizes to upper-snake before looking up, so a topic and a category of the same name DO
  // now agree in colour (topic "Life" and category "LIFE" both resolve to the seeded blue). Before
  // normalization the case-sensitive hash made them disagree 5/5 — N-6.
  const rail = depth === 0 ? `oklch(0.62 0.16 ${categoryHue(node.name)})` : undefined;
  return (
    <li>
      <div className="flex items-stretch">
        {depth === 0 && (
          <span aria-hidden className="mr-1.5 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: rail }} />
        )}
        <button
          type="button"
          disabled={!hasChildren}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={hasChildren ? open : undefined}
          className="-my-1.5 flex min-h-11 min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-3 text-left disabled:cursor-default"
          style={{ paddingLeft: `${depth === 0 ? 0 : depth * 0.875 + 0.75}rem` }}
        >
          <span className="w-3 shrink-0 text-muted-foreground">
            {hasChildren ? (open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />) : null}
          </span>
          <span
            className={cn("min-w-0 flex-1 truncate text-[13px]", depth === 0 ? "text-foreground" : "text-foreground/85")}
            title={node.name}
          >
            {node.name}
          </span>
          {/* `count: null` is a REAL state in Lane B's contract, and the spec renders it BLANK — never
              "0" (Family, Grooming Management and several other sub-topics carry no number at all).
              A zero count is treated the same way, for the same visual reason. */}
          {node.count ? (
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{node.count}</span>
          ) : null}
        </button>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((c) => (
            <TopicRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The topic tree's empty states, one per `TopicTreeResult.reason`. Lane B's contract is explicit
 *  that an empty tree is SUCCESS, not an error, and that `tool-absent` is the expected steady state
 *  until journey deploys `get_task_topics` — so each reason gets its own honest sentence instead of
 *  one generic "no topics", and the band above stays fully usable in every case. */
function TopicsEmpty({ topics }: { topics: TopicTreeResult }) {
  const copy =
    topics.reason === "tool-absent"
      ? "Topic breakdown isn’t available yet — journey hasn’t deployed its topic list. Everything above is live."
      : topics.reason === "not-configured"
        ? "Topic breakdown isn’t configured in this environment. Everything above is live."
        : topics.reason === "error"
          ? `Couldn’t load the topic breakdown${topics.error ? ` — ${topics.error}` : ""}. Everything above is live.`
          : "No topics yet.";
  return <div className="border-t border-hairline px-3 py-3 text-[12px] text-muted-foreground">{copy}</div>;
}

export function PrioritiesWidget({
  data,
  full,
  title,
  onSettings,
  live,
}: {
  data: PrioritiesWidgetData;
  full?: boolean;
  /** Optional heading override (an agent can scope the card, e.g. "Career priorities"). */
  title?: string;
  onSettings?: () => void;
  /** `data` came from a Lane-B read this mount, so it is server truth and must beat any stale
   *  snapshot already in the shared row map. See `useSeededRows`. */
  live?: boolean;
}) {
  const caller = useCaller();
  useSeededRows(data.band, live);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">{title || "Priorities"}</span>
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

      {!data.ok ? (
        <ReadError error={data.error} />
      ) : data.band.length > 0 ? (
        <ScrollBand band full={full}>
          <ul>
            {data.band.map((row) => (
              <PriorityRow key={row.id} row={row} caller={caller} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <EmptyLine band>No priorities right now.</EmptyLine>
      )}

      {data.topics.roots.length > 0 ? (
        <ScrollBand full={full}>
          <ul className="border-t border-hairline py-1">
            {data.topics.roots.map((t) => (
              <TopicRow key={t.id} node={t} depth={0} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <TopicsEmpty topics={data.topics} />
      )}
    </div>
  );
}

/* ── SCHEDULE ───────────────────────────────────────────────────────────────────────────────────── */

function ScheduleRowItem({ row, caller }: { row: WidgetTaskRow; caller: Caller }) {
  const { status } = useRowState(row);
  const done = status === "DONE";
  const time = shortTime(row.startTime);
  return (
    <li className="flex items-center gap-2 border-b border-hairline px-3 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {time && <span className="shrink-0 text-[12px] font-semibold tabular-nums text-foreground">{time}</span>}
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

export function ScheduleWidget({
  data,
  full,
  live,
}: {
  data: ScheduleWidgetData;
  full?: boolean;
  /** See `PrioritiesWidget.live` / `useSeededRows` — live server truth overwrites a stale snapshot. */
  live?: boolean;
}) {
  const caller = useCaller();
  // ONE seed pass over every row in the widget, so a task that Lane B legitimately places in two
  // sections is tracked once and agrees with itself. (Lane B de-dupes `upNext` against the other
  // two, so in practice this is belt-and-braces — and it is the cheap half.)
  const allRows = useMemo(
    () => [...data.todaySchedule, ...data.currentlyDoing, ...data.upNext],
    [data.todaySchedule, data.currentlyDoing, data.upNext],
  );
  useSeededRows(allRows, live);
  const doing = data.currentlyDoing[0];

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft">
      <div className="px-3 py-2">
        <WidgetComposeRow placeholder="What's next…" />
      </div>

      {!data.ok && <ReadError error={data.error} />}

      <SectionLabel>Today’s schedule</SectionLabel>
      {data.todaySchedule.length > 0 ? (
        <ScrollBand full={full}>
          <ul className="border-t border-hairline">
            {data.todaySchedule.map((row) => (
              <ScheduleRowItem key={row.id} row={row} caller={caller} />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <div className="border-t border-hairline">
          <EmptyLine>Nothing scheduled for today.</EmptyLine>
        </div>
      )}

      <SectionLabel>Currently doing</SectionLabel>
      <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
        {/* The spec puts this in BOLD and spells the empty state out. Lane B's contract is explicit
            that `currentlyDoing: []` is a NORMAL result, so this is a legitimate state, not an
            error — and a blank section here would read as a rendering failure. */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-foreground" title={doing?.title}>
          {doing ? doing.title : "Nothing in progress"}
        </span>
        {doing ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <DoneButton row={doing} caller={caller} />
            <PauseButton row={doing} caller={caller} />
          </div>
        ) : (
          /* THE SPEC DRAWS BOTH BUTTONS BESIDE "Nothing in progress" — read from
             docs/widgets/spec-schedule-widget.jpg this session: a full-size green ✓ and orange ⏸ sit
             on the empty row exactly as they do on a populated one. Hiding them made the row collapse
             to text and lose the widget's shape, which is the divergence N-7 filed.
             RENDERED, BUT DISABLED. A live-looking button with no task to act on is a dead control —
             the user taps and nothing happens. On an Android home widget these are fixed chrome; on
             the web the honest equivalent is the same geometry and colour, visibly inert. */
          <div className="flex shrink-0 items-center gap-0.5">
            <EmptyDoingControl kind="done" />
            <EmptyDoingControl kind="pause" />
          </div>
        )}
      </div>

      <SectionLabel>Up next</SectionLabel>
      <div style={BAND_STYLE}>
        <div className="flex items-center gap-1.5 px-3 pt-2">
          <Star size={11} className="fill-current" style={{ color: "var(--warning)" }} aria-hidden />
          <span className="text-[12px] font-bold" style={{ color: "var(--warning-foreground)" }}>
            This Week
          </span>
        </div>
        {data.upNext.length > 0 ? (
          <ScrollBand full={full}>
            <ul className="pb-1">
              {data.upNext.map((row) => (
                <UpNextRowItem key={row.id} row={row} caller={caller} />
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

/* ── Live data (docked + full-page copies) ───────────────────────────────────────────────────────
 * A widget rendered from a chat MESSAGE carries its own snapshot payload. The docked copy in Iris's
 * 1:1 and the two full-page views have no message, so they read live through Lane B's server fns.
 * Neither fn throws — a failure is `ok:false` with empty sections — so there is no catch-and-invent
 * path here, and `ReadError` inside each widget is what tells the user a read failed. */

function useScheduleData(): { loading: boolean; data: ScheduleWidgetData | null } {
  const caller = useCaller();
  const [state, setState] = useState<{ loading: boolean; data: ScheduleWidgetData | null }>({
    loading: true,
    data: null,
  });
  useEffect(() => {
    let cancelled = false;
    void getScheduleWidget({ data: { caller, timeZone: TIME_ZONE } })
      .then((d) => {
        if (!cancelled) setState({ loading: false, data: d });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [caller]);
  return state;
}

function usePrioritiesData(): { loading: boolean; data: PrioritiesWidgetData | null } {
  const caller = useCaller();
  const [state, setState] = useState<{ loading: boolean; data: PrioritiesWidgetData | null }>({
    loading: true,
    data: null,
  });
  useEffect(() => {
    let cancelled = false;
    void getPrioritiesWidget({ data: { caller, timeZone: TIME_ZONE } })
      .then((d) => {
        if (!cancelled) setState({ loading: false, data: d });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [caller]);
  return state;
}

function WidgetPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-4 text-[12px] text-muted-foreground shadow-soft">
      <Loader2 size={13} className="animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/** Shown only when the server fn itself could not be reached (a transport failure — the fns never
 *  throw of their own accord), which is why it is a separate, plainer message from `ReadError`. */
function WidgetUnreachable({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-3 py-4 text-[12px] text-destructive shadow-soft">
      Couldn’t reach {label}. Check your connection and reopen this view.
    </div>
  );
}

/* ── Docked pair (Iris's 1:1) ────────────────────────────────────────────────────────────────────
 * "Docked" = persistently present in that huddle, NOT a message. Rendered by Transcript above the
 * message list, so it is there whether or not a tool ever fired, and — critically — it is NOT in
 * `messages`, which is what `history` (and therefore the turn payload sent to the model, and the
 * unread watermark) is built from. A pinned MESSAGE would have leaked a widget payload into every
 * turn's prompt and into the scrollback the user reads; this cannot.
 *
 * EXPANDED by default, and the strip is labelled "Docked in this huddle" — both taken from the
 * design prototype committed alongside the spec (docs/widgets/prototype/canvas.json, annotation
 * `docked-placement`: "Both widgets sit in a two-up grid under a 'Docked in this huddle' strip,
 * ABOVE the transcript, inside Iris's 1:1 only. They are pinned furniture, not chat messages").
 * An earlier version of this collapsed by default to avoid burying the conversation; the prototype
 * is the design intent, so it wins — the disclosure is kept so the user can still fold it away. */
export function DockedJourneyWidgets() {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-hairline bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="text-[12px] font-semibold text-foreground">Docked in this huddle</span>
        <span className="text-[11px] text-muted-foreground">· priorities &amp; schedule</span>
      </button>
      {/* Mounted only while open, so the two Lane-B reads do not fire for a user who folds it away. */}
      {open && (
        <div className="grid gap-3 px-2 pb-2 lg:grid-cols-2">
          <LivePrioritiesWidget />
          <LiveScheduleWidget />
        </div>
      )}
    </div>
  );
}

function LivePrioritiesWidget({ full }: { full?: boolean }) {
  const { loading, data } = usePrioritiesData();
  if (loading) return <WidgetPlaceholder label="Loading your priorities…" />;
  if (!data) return <WidgetUnreachable label="your priorities" />;
  // `live` — this payload IS the Lane-B read, so it must overwrite any stale in-chat snapshot that
  // seeded the shared row map first (see useSeededRows).
  return <PrioritiesWidget data={data} full={full} live />;
}

function LiveScheduleWidget({ full }: { full?: boolean }) {
  const { loading, data } = useScheduleData();
  if (loading) return <WidgetPlaceholder label="Loading your schedule…" />;
  if (!data) return <WidgetUnreachable label="your schedule" />;
  // `live` — same reason as LivePrioritiesWidget.
  return <ScheduleWidget data={data} full={full} live />;
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
  return (
    <WidgetPage title="Priorities">
      <LivePrioritiesWidget full />
    </WidgetPage>
  );
}

export function ScheduleView() {
  return (
    <WidgetPage title="Schedule">
      <LiveScheduleWidget full />
    </WidgetPage>
  );
}
