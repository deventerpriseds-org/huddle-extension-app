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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronRight,
  ChevronUp,
  Loader2,
  Mic,
  Pause,
  Play,
  Send,
  MoreVertical,
  Settings,
  Star,
  StarOff,
  Triangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { CATEGORY_ROOT_PREFIX, UNCATEGORISED_CATEGORY } from "../lib/tasks/widget-ids";
import type {
  PushView,
  PrioritiesWidgetData,
  ScheduleWidgetData,
  TopicNode,
  TopicTreeResult,
  WidgetTaskAction,
  WidgetTaskRow,
} from "../lib/tasks/widgets.server";
import { categoryChromaScale, categoryHue } from "../lib/tasks/widget-colors";
import {
  focusWidgetItems,
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
  // 0 for a category the spec draws GREY (Family); 1 otherwise. See widget-colors.ts.
  const cs = categoryChromaScale(category);
  // journey stores categories upper-snake (LIFE, PROF_EDUCATION); the spec shows them title-cased.
  const label = category
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      // `max-w` + truncate, NOT shrink-0: measured on the owner's 390px screen a row spent ~291px
      // on this chip, the three controls and the gaps, leaving the TITLE ~99px ("Fix the Nexus...").
      // The title is the content; the chip is only its label, so the label is what yields.
      className="max-w-[4.5rem] shrink truncate rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none"
      style={{
        backgroundColor: `oklch(0.95 ${0.05 * cs} ${h} / 0.55)`,
        color: `oklch(0.42 ${0.13 * cs} ${h})`,
      }}
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
      className={cn(CTRL_BASE, "-my-2 min-h-11 px-1.5")}
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

/** ▶ start → DOING. The spec pairs a LIGHTER teal ▶ beside a DARKER green ✓.
 *  This was a color-mix of `--success` against `--surface`, which is oklch(1 0 0) — white with an
 *  EXPLICIT hue of 0 — so it dragged hue 155 to 111.6 and rendered YELLOW-GREEN, not a lighter teal.
 *  Identical defect to the pink band (D-1), found by sweeping every color-mix in the repo.
 *  `--success-soft` is a literal at the SAME hue, lit per theme. */
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
        backgroundColor: "var(--success-soft)",
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
 * sent before it is sent, which a blind widget-side create would not give them.
 *
 * EXCEPT `focus` (the Priorities widget, owner 2026-10-16): "currently typing in the priorities tab
 * switches views to iris 1:1 but i wont always be going there". Send then STAYS PUT and runs the same
 * "focus on these" core the `focus_on` agent tool uses (focus.server.ts): existing tasks are started,
 * missing ones created then started, the result toasted and the widget re-read — journey's Focus view
 * behaviour. Still journey-canonical: every write goes through journey's own tools. */
function WidgetComposeRow({
  placeholder,
  prefix,
  focus,
  onDone,
}: {
  placeholder: string;
  prefix?: string;
  focus?: boolean;
  onDone?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const caller = useCaller();
  const dictation = useDictation();
  const view = useHuddleStore((s) => s.view);
  const activeHuddleId = useHuddleStore((s) => s.activeHuddleId);
  const setActive = useHuddleStore((s) => s.setActive);
  const setDraftPrefill = useHuddleStore((s) => s.setDraftPrefill);

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t || busy) return;
    if (focus) {
      setBusy(true);
      void focusWidgetItems({ data: { caller, text: t } })
        .then((r) => {
          if (r.ok) {
            setText("");
            toast.success(r.summary);
          } else toast.error(r.summary || r.error || "Couldn't start those.");
          onDone?.();
          // journey → mirror sync lags 1-3s; re-read again once it has landed.
          setTimeout(() => onDone?.(), 2500);
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't start those."))
        .finally(() => setBusy(false));
      return;
    }
    // Only relocate when there is no composer on screen to receive the text (a full-page widget view,
    // or some other huddle). Typing into the docked widget while already in a chat should not yank
    // the user out of the conversation they are in.
    if (view !== "huddle" || activeHuddleId !== WIDGET_DOCK_HUDDLE_ID) setActive(WIDGET_DOCK_HUDDLE_ID);
    setDraftPrefill(prefix ? `${prefix}${t}` : t);
    setText("");
  }, [text, busy, focus, caller, onDone, view, activeHuddleId, setActive, setDraftPrefill, prefix]);

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
        disabled={busy}
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
        disabled={!text.trim() || busy}
        aria-label={focus ? "Start these" : "Send to Iris"}
        className="-my-2 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40"
        style={{ color: "var(--ai)" }}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} className="fill-current" />}
      </button>
    </div>
  );
}

/* ── Section chrome ──────────────────────────────────────────────────────────────────────────────
 * The cream/pale-yellow band from both screenshots. This reads ONE token, `--band-cream`, which
 * styles.css defines per theme (light, dark and the always-dark meeting stage) as an explicit
 * hue-92 literal.
 *
 * It used to be `color-mix(in oklch, var(--warning) 9%, var(--surface))`, and that shipped PINK.
 * `--warning` is hue 55, but `--surface` is `oklch(1 0 0)` — white written with an EXPLICIT hue of
 * ZERO, not a hueless white — so oklch interpolated 55 -> 0 and the 9% mix landed at hue ~4.95,
 * chroma ~0.0144. That is a pale pink, and the owner saw it as one on his phone. Deriving the band
 * from a mix against ANY neutral whose hue channel is written as 0 collapses the hue the same way,
 * so the band is a literal now and the per-theme relighting happens in styles.css where the rest of
 * the palette lives. Guarded by scripts/widget-band-color.test.ts. */
const BAND_STYLE: React.CSSProperties = {
  backgroundColor: "var(--band-cream)",
};

/** The widget's OUTER chrome, and the whole of defect D-4.
 *
 *  Every widget used to render `rounded-xl border border-hairline bg-surface shadow-soft`
 *  unconditionally. That is right for a card in the chat stream and wrong everywhere else:
 *    - as a full-page VIEW it drew a small bordered card marooned in a large empty panel, which is
 *      what the owner called "cards instead of using the entire panel";
 *    - in the DOCK it drew a bordered card inside the dock's own bordered shell — a box in a box.
 *
 *  Three contexts, one function, so a fourth caller cannot invent a fourth look:
 *    card — the chat stream. Unchanged: it IS a card, floating on the transcript.
 *    page — a full-page view. No border, no radius, no shadow: the PANEL is the container, the
 *           widget fills it, and the widget's own sections do the scrolling.
 *    bare — docked. No chrome at all; the dock shell already provides it. */
function widgetShell(chrome: "card" | "page" | "bare"): string {
  if (chrome === "page") return "flex min-h-0 min-w-0 flex-1 flex-col bg-surface";
  if (chrome === "bare") return "overflow-hidden bg-surface";
  return "overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft";
}

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

/* ── The ⋮ action menu ─────────────────────────────────────────────────────────────────────────────
 * Owner, 2026-10-15, approved from the prototype (artifact 2dnuJJaYUMGqhxUysapcJ6): "what if on mobile,
 * a context menu popped up from clicking the action menu to the left … and the left text wrapped".
 * Every row's actions live behind ONE 44px ⋮ button on its left, so the title takes the rest of the
 * width and wraps instead of being cut off. The old inline Today / ✓ / ⏸ / ▲▼ strip is gone from these
 * rows (Today removed entirely — "i only see today under task which i dont like").
 *
 * PORTALLED AND FIXED-POSITIONED, not absolute inside the row: the tree and band sit in
 * `overflow-y-auto` ScrollBands, which would clip an absolutely-positioned menu near their bottom edge.
 * The menu opens below the button, or ABOVE it when there is not room below. Any scroll closes it — a
 * fixed menu left behind by a scrolling list would point at the wrong row. */

type MenuItem = { key: string; label: string; sub?: string; icon: React.ReactNode; onSelect: () => void };

const MENU_WIDTH = 272;
const MENU_ROOM = 300;

function RowMenu({ label, heading, items }: { label: string; heading: string; items: MenuItem[] }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Keyboard: focus moves INTO the menu on open, ↑/↓ (and Home/End) walk its items, Escape closes and
  // hands focus back to the ⋮ that opened it (VERIFY-category-push-1 D7).
  const close = useCallback((restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!anchor) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
        return;
      }
      // Tabbing away closes the menu, so its arrow keys can never capture another field (VERIFY N L2).
      if (e.key === "Tab") {
        close(true);
        return;
      }
      const its = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      if (!its.length) return;
      const at = its.indexOf(document.activeElement as HTMLButtonElement);
      const go = (i: number) => its[(i + its.length) % its.length]?.focus();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        go(at + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        go(at - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(its.length - 1);
      }
    };
    const dismiss = () => close();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, close]);
  const open = anchor !== null;
  let pos: React.CSSProperties = {};
  if (anchor && typeof window !== "undefined") {
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
    pos =
      window.innerHeight - anchor.bottom >= MENU_ROOM
        ? { left, top: anchor.bottom + 4 }
        : { left, bottom: window.innerHeight - anchor.top + 4 };
  }
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => setAnchor(open ? null : e.currentTarget.getBoundingClientRect())}
        className={cn(
          "-my-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:text-foreground",
          open && "bg-accent text-accent-foreground",
        )}
      >
        <MoreVertical size={17} aria-hidden />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => close(true)}
              className="fixed inset-0 z-[90] cursor-default bg-foreground/10"
            />
            <div
              ref={menuRef}
              role="menu"
              aria-label={label}
              style={{ ...pos, width: MENU_WIDTH }}
              className="fixed z-[91] overflow-hidden rounded-xl bg-card shadow-xl ring-1 ring-hairline"
            >
              <div className="border-b border-hairline px-3.5 pb-2 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {heading}
              </div>
              {items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(true); // focus back on ⋮, not lost to <body> (VERIFY-category-push-2 L1)
                    it.onSelect();
                  }}
                  className="flex min-h-12 w-full items-start gap-3 border-t border-hairline/60 px-3.5 py-3 text-left first-of-type:border-t-0 hover:bg-muted"
                >
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-primary">{it.icon}</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[14px] font-medium text-foreground">{it.label}</span>
                    {it.sub && <span className="text-[12px] leading-snug text-muted-foreground">{it.sub}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

const STAR_FILLED = <Star size={17} className="fill-amber-500 text-amber-500" aria-hidden />;

/** Context every priorities row needs to act: who is acting, whether this card is the LIVE widget (a
 *  frozen in-chat snapshot never pushes — its ids could be days old), what is pushed, and how to
 *  re-read the widget after a push lands. */
type PushCtx = {
  caller: Caller;
  live: boolean;
  pushes: PushView[];
  onChanged?: () => void;
};

/** One push/un-push call → toast → re-read the widget (now, and again once the ~1-3s mirror sync has
 *  caught up, so the new star shows without a manual refresh). */
async function runPush(
  ctx: PushCtx,
  call: "task" | "unstar" | "node" | "unpush",
  args: { taskId?: string; nodeId?: string; nodeName?: string },
): Promise<void> {
  try {
    const fns = await import("../lib/tasks/widgets.functions");
    const caller = ctx.caller;
    const r =
      call === "task"
        ? await fns.pushWidgetTask({ data: { caller, taskId: args.taskId! } })
        : call === "unstar"
          ? await fns.unstarWidgetTask({ data: { caller, taskId: args.taskId! } })
          : call === "node"
            ? await fns.pushWidgetNode({ data: { caller, nodeId: args.nodeId!, nodeName: args.nodeName } })
            : await fns.unpushWidgetNode({ data: { caller, nodeId: args.nodeId! } });
    if (!r.ok) {
      toast.error(r.error || "Couldn't update This Week.");
      return;
    }
    if (call === "task") toast.success(r.applied ? "Pushed to This Week." : (r.message ?? "Already in This Week."));
    else if (call === "unstar") toast.success("Removed from This Week.");
    else if (call === "node")
      toast.success(
        r.task
          ? `${r.applied ? "Pushed" : "Already pushed"} ${args.nodeName ?? ""} — starred: ${r.task.title}`
          : (r.message ?? "Pushed — the next task that lands there gets starred."),
      );
    else toast.success(`Stopped pushing ${args.nodeName ?? ""}.`);
    ctx.onChanged?.();
    setTimeout(() => ctx.onChanged?.(), 2500);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't update This Week.");
  }
}

/** The task actions every task row shares: Start, Mark done, Park — the SAME runAction write path the
 *  schedule widget's buttons use (one writer into journey, optimistic with visible rollback). */
function taskActionItems(row: WidgetTaskRow, caller: Caller, status: string, viaName?: string | null): MenuItem[] {
  const items: MenuItem[] = [];
  if (status !== "DOING") {
    items.push({
      key: "start",
      label: "Start",
      sub: "Moves it to Doing",
      icon: <Play size={15} className="fill-current" aria-hidden />,
      onSelect: () => void runAction(row, caller, "start", { status: "DOING", prevStatus: status }),
    });
  }
  items.push({
    key: "done",
    label: "Mark done",
    sub: viaName ? `The next task from ${viaName} takes its place` : undefined,
    icon: <Check size={17} strokeWidth={3} className="text-emerald-600" aria-hidden />,
    onSelect: () => void runAction(row, caller, "done", { status: "DONE", prevStatus: status }),
  });
  items.push({
    key: "park",
    label: "Park",
    sub: "Out of all automation until you bring it back",
    icon: <Pause size={15} className="fill-current" aria-hidden />,
    onSelect: () => void runAction(row, caller, "pause", { status: "BACKLOG", prevStatus: status }),
  });
  return items;
}

/** A task title with the star docked to its LEFT and the meta line (date, chip, via) lined up under the
 *  TITLE, not under the star (owner comment on the prototype). */
function TaskTitle({
  row,
  done,
  starred,
  chip,
  muted,
}: {
  row: WidgetTaskRow;
  done: boolean;
  starred: boolean;
  chip?: boolean;
  muted?: boolean;
}) {
  const due = row.dueDate ? shortDate(row.dueDate) : null;
  const hasMeta = (chip && !!row.category) || !!due || !!row.pushedVia;
  return (
    <div className="min-w-0 flex-1 py-2">
      <div className="flex items-start gap-1.5">
        {starred && <Star aria-label="In This Week" className="mt-[3px] h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" />}
        <span
          className={cn(
            "min-w-0 break-words text-[13.5px] leading-snug",
            done ? "text-muted-foreground line-through" : muted ? "text-foreground/85" : "text-foreground",
          )}
        >
          {row.title}
        </span>
      </div>
      {hasMeta && (
        <div className={cn("mt-1 flex flex-wrap items-center gap-1.5", starred && "pl-5")}>
          {chip && <CategoryChip category={row.category} />}
          {due && <span className="text-[11.5px] text-muted-foreground">Due {due}</span>}
          {row.pushedVia && <span className="text-[11.5px] text-muted-foreground">via {row.pushedVia}</span>}
        </div>
      )}
    </div>
  );
}

/** "2026-10-16…" → "Oct 16". Date-only strings are read as calendar dates, never shifted by timezone. */
function shortDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/**
 * One row of the This Week band: ⋮ on the left, the title wrapping across the rest.
 *
 * Done and Park go through `runAction` exactly as before (they were mounted here for the owner's
 * "i also cant mark something cmplete or parking lot it"); reordering moved from the ▲▼ pair into the
 * menu as Move up / Move down, and still writes through `reorderWidgetBand`. Removing a row takes its
 * star off in journey, so it leaves This Week on the phone too.
 */
function PriorityRow({
  row,
  ctx,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  row: WidgetTaskRow;
  ctx: PushCtx;
  onMove?: (taskId: string, dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const { status } = useRowState(row);
  const done = status === "DONE";
  const items = taskActionItems(row, ctx.caller, status, row.pushedVia).filter((i) => i.key !== "start");
  if (ctx.live) {
    items.push({
      key: "unstar",
      label: "Remove from This Week",
      icon: <StarOff size={17} aria-hidden />,
      onSelect: () => void runPush(ctx, "unstar", { taskId: row.id }),
    });
  }
  if (onMove && canMoveUp) {
    items.push({ key: "up", label: "Move up", icon: <ArrowUp size={17} aria-hidden />, onSelect: () => onMove(row.id, -1) });
  }
  if (onMove && canMoveDown) {
    items.push({ key: "down", label: "Move down", icon: <ArrowDown size={17} aria-hidden />, onSelect: () => onMove(row.id, 1) });
  }
  return (
    <li className="flex items-start gap-1 border-b border-hairline px-1.5 py-0.5 last:border-b-0">
      <RowMenu label={`Actions for “${row.title}”`} heading="This week" items={items} />
      <TaskTitle row={row} done={done} starred={row.isPriority} chip />
    </li>
  );
}

/** One category or topic and its children. ⋮ on the left pushes / stops pushing it; the arrow on the
 *  RIGHT opens it, so the two controls can never be confused. A pushed node shows a star right after its
 *  name — filled while it has a task starred, outlined while it waits for one. Expansion is local state:
 *  per-view chrome, no consequence if it resets. */
function TopicRow({
  node,
  depth,
  ctx,
  defaultOpen = false,
}: {
  node: TopicNode;
  depth: number;
  ctx: PushCtx;
  defaultOpen?: boolean;
}) {
  // Expandable when it has sub-topics OR tasks — a category of tasks with no sub-topic is still a
  // working surface, never a dead count.
  const hasChildren = node.children.length > 0;
  const hasTasks = node.tasks.length > 0;
  const hasContent = hasChildren || hasTasks;
  // NO ROW CAP (AC-journey-widgets AC-10). ONE row starts open — the first, as the spec draws it.
  const [open, setOpen] = useState(defaultOpen && hasContent);
  const rail =
    depth === 0
      ? `oklch(0.62 ${0.16 * categoryChromaScale(node.name)} ${categoryHue(node.name)})`
      : undefined;
  const pushable = ctx.live && node.id !== `${CATEGORY_ROOT_PREFIX}${UNCATEGORISED_CATEGORY}`;
  const push = ctx.pushes.find((p) => p.nodeId === node.id);
  const kind = node.id.startsWith(CATEGORY_ROOT_PREFIX) ? "Category" : "Topic";
  const items: MenuItem[] = push
    ? [
        {
          key: "unpush",
          label: `Stop pushing ${node.name}`,
          sub: "Takes the star off the task this push starred",
          icon: <Ban size={17} aria-hidden />,
          onSelect: () => void runPush(ctx, "unpush", { nodeId: node.id, nodeName: node.name }),
        },
      ]
    : [
        {
          key: "push",
          label: `Push ${node.name}`,
          sub: hasContent
            ? "Huddle stars its best task now, and the next one when you finish"
            : "Nothing here yet — the next task that lands gets starred",
          icon: STAR_FILLED,
          onSelect: () => void runPush(ctx, "node", { nodeId: node.id, nodeName: node.name }),
        },
      ];
  return (
    <li className={cn("border-t", depth === 0 ? "border-hairline" : "border-hairline/50")}>
      <div className="flex items-stretch">
        {depth === 0 && (
          <span aria-hidden className="mr-0.5 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: rail }} />
        )}
        <div
          className="flex min-w-0 flex-1 items-start gap-1 pr-1"
          style={{ paddingLeft: `${depth === 0 ? 0.125 : depth * 0.875 + 0.125}rem` }}
        >
          {pushable ? (
            <RowMenu label={`Actions for ${node.name}`} heading={`${kind} · ${node.name}`} items={items} />
          ) : (
            <span className="w-11 shrink-0" aria-hidden />
          )}
          <span className="flex min-w-0 flex-1 items-start gap-1.5 py-2.5">
            {/* Grey when there is nothing under it — category or topic (owner: "there currently is
                nothing to do if pushing it"). */}
            <span
              className={cn(
                "min-w-0 break-words text-[13.5px] leading-snug",
                depth === 0 && "font-semibold",
                !hasContent ? "text-muted-foreground" : depth === 0 ? "text-foreground" : "text-foreground/85",
              )}
            >
              {node.name}
            </span>
            {push && (
              <Star
                aria-label={push.activeTaskId ? "Pushed — one task starred" : "Pushed — waiting for a task"}
                className={cn(
                  "mt-[2px] h-3.5 w-3.5 shrink-0 text-amber-500",
                  push.activeTaskId && "fill-amber-500",
                )}
              />
            )}
          </span>
          {/* `count: null` renders BLANK, never "0" — as the spec draws empty rows. */}
          {node.count ? (
            <span className="shrink-0 pt-2.5 text-[12px] tabular-nums text-muted-foreground">{node.count}</span>
          ) : null}
          {hasContent ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
              className="-my-0.5 flex size-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <ChevronRight size={16} className={cn("transition-transform", open && "rotate-90")} aria-hidden />
            </button>
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
        </div>
      </div>
      {hasContent && open && (
        <ul>
          {/* Sub-topics first, then this node's own tasks — the Android widget's order. */}
          {node.children.map((c) => (
            <TopicRow key={c.id} node={c} depth={depth + 1} ctx={ctx} />
          ))}
          {node.tasks.map((row) => (
            <TopicTaskRow key={row.id} row={row} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One task inside the category/topic tree: ⋮ on the left (Push to This Week / Remove, Start, Mark
 *  done, Park), the title wrapping across the rest. Same single write paths as the band. */
function TopicTaskRow({ row, depth, ctx }: { row: WidgetTaskRow; depth: number; ctx: PushCtx }) {
  const { status } = useRowState(row);
  const done = status === "DONE";
  const items: MenuItem[] = [];
  if (ctx.live) {
    items.push(
      row.isPriority
        ? {
            key: "unstar",
            label: "Remove from This Week",
            icon: <StarOff size={17} aria-hidden />,
            onSelect: () => void runPush(ctx, "unstar", { taskId: row.id }),
          }
        : {
            key: "push",
            label: "Push to This Week",
            sub: "You choose — it goes first in tonight's scheduling",
            icon: STAR_FILLED,
            onSelect: () => void runPush(ctx, "task", { taskId: row.id }),
          },
    );
  }
  items.push(...taskActionItems(row, ctx.caller, status));
  return (
    <li
      className="flex items-start gap-1 border-t border-hairline/40 pr-2"
      style={{ paddingLeft: `${depth * 0.875 + 0.125}rem` }}
    >
      <RowMenu label={`Actions for “${row.title}”`} heading="Task" items={items} />
      <TaskTitle row={row} done={done} starred={row.isPriority} muted />
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
      ? "Sub-themes within each category aren’t available yet — journey hasn’t deployed its topic list. Everything above is live."
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
  chrome = "card",
  onChanged,
}: {
  data: PrioritiesWidgetData;
  full?: boolean;
  /** Optional heading override (an agent can scope the card, e.g. "Career priorities"). */
  title?: string;
  onSettings?: () => void;
  /** `data` came from a Lane-B read this mount, so it is server truth and must beat any stale
   *  snapshot already in the shared row map. See `useSeededRows`. */
  live?: boolean;
  /** Outer chrome. Defaults to the chat-stream card; see `widgetShell`. */
  chrome?: "card" | "page" | "bare";
  /** Re-read the widget — the live widget passes it so a push shows without a manual refresh. */
  onChanged?: () => void;
}) {
  const caller = useCaller();
  useSeededRows(data.band, live);
  const pushCtx: PushCtx = useMemo(
    () => ({ caller, live: live === true && data.ok, pushes: data.pushes ?? [], onChanged }),
    [caller, live, data.ok, data.pushes, onChanged],
  );

  // The user's This Week ordering, applied optimistically on top of the server's.
  //
  // REORDER IS ENABLED ONLY ON A `live` WIDGET. A per-reply chat card is a FROZEN SNAPSHOT of the
  // band as it was when that message was sent (see the `live` prop) — letting someone drag rows in
  // a three-day-old card would persist an ordering built from a list that no longer exists.
  const [override, setOverride] = useState<string[] | null>(null);
  const canReorder = live === true && data.ok && data.band.length > 1;

  const shown = useMemo(() => {
    if (!override) return data.band;
    // Map preserves insertion order, so whatever the override does not name keeps the server's
    // order underneath — the same sparse-pin semantics `applyWeekOrder` uses on the server.
    const rest = new Map(data.band.map((r) => [r.id, r] as const));
    const out: typeof data.band = [];
    for (const id of override) {
      const r = rest.get(id);
      if (r) {
        out.push(r);
        rest.delete(id);
      }
    }
    return [...out, ...rest.values()];
  }, [data.band, override]);

  const onMove = useCallback(
    (taskId: string, dir: -1 | 1) => {
      const ids = shown.map((r) => r.id);
      const from = ids.indexOf(taskId);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      setOverride(ids); // paint immediately; the write below is what makes it survive a reload
      void (async () => {
        try {
          const { reorderWidgetBand } = await import("@/features/huddle/lib/tasks/widgets.functions");
          const res = await reorderWidgetBand({ data: { caller, taskIds: ids } });
          if (!res?.ok) setOverride(null); // roll back to server order rather than lying
        } catch {
          setOverride(null);
        }
      })();
    },
    [shown, caller],
  );

  return (
    <div className={widgetShell(chrome)}>
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
        <WidgetComposeRow placeholder="What do you want to work on? (comma-separated)" focus onDone={onChanged} />
      </div>

      {!data.ok ? (
        <ReadError error={data.error} />
      ) : data.band.length > 0 ? (
        <ScrollBand band full={full}>
          <ul>
            {shown.map((row, i) => (
              <PriorityRow
                key={row.id}
                row={row}
                ctx={pushCtx}
                onMove={canReorder ? onMove : undefined}
                canMoveUp={i > 0}
                canMoveDown={i < shown.length - 1}
              />
            ))}
          </ul>
        </ScrollBand>
      ) : (
        <EmptyLine band>Nothing in This Week yet. Tap ⋮ on a task, topic or category below to push it here.</EmptyLine>
      )}

      {data.topics.roots.length > 0 ? (
        <>
          <ScrollBand full={full}>
            <ul className="border-t border-hairline py-1">
              {data.topics.roots.map((t, i) => (
                <TopicRow key={t.id} node={t} depth={0} ctx={pushCtx} defaultOpen={i === 0} />
              ))}
            </ul>
          </ScrollBand>
          {/* The tree now renders from the MIRROR's categories, so it is populated even while
              journey's topic tool is unavailable. That would otherwise HIDE the missing theme layer
              entirely — the rows look complete, so nobody would know sub-themes are absent. Say so
              instead: `reason` still describes the journey passthrough, untouched by the merge. */}
          {data.topics.reason !== "ok" && <TopicsEmpty topics={data.topics} />}
        </>
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
  chrome = "card",
}: {
  data: ScheduleWidgetData;
  full?: boolean;
  /** See `PrioritiesWidget.live` / `useSeededRows` — live server truth overwrites a stale snapshot. */
  live?: boolean;
  /** Outer chrome. Defaults to the chat-stream card; see `widgetShell`. */
  chrome?: "card" | "page" | "bare";
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
    <div className={widgetShell(chrome)}>
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

function usePrioritiesData(): { loading: boolean; data: PrioritiesWidgetData | null; reload: () => void } {
  const caller = useCaller();
  const [state, setState] = useState<{ loading: boolean; data: PrioritiesWidgetData | null }>({
    loading: true,
    data: null,
  });
  // Bumped by `reload` — a push re-reads the widget so the new star, the "via" line and the pushed
  // node's star appear without a manual refresh. The previous payload stays on screen meanwhile.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    void getPrioritiesWidget({ data: { caller, timeZone: TIME_ZONE } })
      .then((d) => {
        if (!cancelled) setState({ loading: false, data: d });
      })
      .catch(() => {
        // Keep what is on screen if a RE-read fails; only the first read may land on "unreachable".
        if (!cancelled) setState((prev) => ({ loading: false, data: prev.data }));
      });
    return () => {
      cancelled = true;
    };
  }, [caller, nonce]);
  return { ...state, reload };
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

/* ── Docked pair (Iris's 1:1) — REMOVED 2026-10-18 ─────────────────────────────────────────────
 * Owner: "The docked priority and schedule widgets are not actually docked so they can be removed
 * from the 1:1 thread stream given we already have tabs at the bottom for me to get to them."
 * The Priorities and Schedule tabs (PrioritiesView / ScheduleView below) are the home for both. */

function LivePrioritiesWidget({
  full,
  chrome,
}: {
  full?: boolean;
  chrome?: "card" | "page" | "bare";
}) {
  const { loading, data, reload } = usePrioritiesData();
  if (loading) return <WidgetPlaceholder label="Loading your priorities…" />;
  if (!data) return <WidgetUnreachable label="your priorities" />;
  // `live` — this payload IS the Lane-B read, so it must overwrite any stale in-chat snapshot that
  // seeded the shared row map first (see useSeededRows).
  return <PrioritiesWidget data={data} full={full} live chrome={chrome} onChanged={reload} />;
}

function LiveScheduleWidget({
  full,
  chrome,
}: {
  full?: boolean;
  chrome?: "card" | "page" | "bare";
}) {
  const { loading, data } = useScheduleData();
  if (loading) return <WidgetPlaceholder label="Loading your schedule…" />;
  if (!data) return <WidgetUnreachable label="your schedule" />;
  // `live` — same reason as LivePrioritiesWidget.
  return <ScheduleWidget data={data} full={full} live chrome={chrome} />;
}

/* ── Full-page views (side menu) ─────────────────────────────────────────────────────────────────── */

/** A full-page widget view. D-4: this used to pad the panel (`px-3 py-4 sm:px-6`) and then constrain
 *  the widget to `max-w-3xl` inside it, so on any wide screen the view was a narrow card sitting in a
 *  large empty area — and on a phone it was a card with a margin all round it for no reason. The
 *  view's OWN chrome is the container now: the header bar is the page header, and the widget fills
 *  the rest of the panel edge to edge and scrolls its own sections. */
function WidgetPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="border-b border-hairline bg-surface px-3 py-2.5 sm:px-6">
        <h1 className="text-sm font-semibold text-foreground">{title}</h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </section>
  );
}

export function PrioritiesView() {
  return (
    <WidgetPage title="Priorities">
      <LivePrioritiesWidget full chrome="page" />
    </WidgetPage>
  );
}

export function ScheduleView() {
  return (
    <WidgetPage title="Schedule">
      <LiveScheduleWidget full chrome="page" />
    </WidgetPage>
  );
}
