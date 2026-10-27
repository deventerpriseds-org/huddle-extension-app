// WHAT:       The scheduled PRIORITY CHECK: twice a day Iris asks "are these priorities still
//             right?" in her 1:1 and presents the priorities widget, so the owner can fix stale
//             items with the widget's own controls BEFORE the jobs that consume the board run.
// WHY:        Owner, 2026-10-05: "I have a priority widget available to agents. but none of the
//             agents send me a message asking me to look at it at a given time so it is up to date
//             before grooming scheduling jobs etc." Asked first 2026-09-10 (8am + 8pm), reframed
//             2026-10-05 from a digest into a FRESHNESS GATE, morning moved to 6am. The 8pm edition
//             protects journey's nightly-schedule-builder (1am ET); the 6am one protects the 8am
//             groom and the 9am auto-work pass.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/plan-agent-routines.md (Phase 0: the rail and the model's widget call proven
//             live 2026-10-05). Tests: bun scripts/priority-check.test.ts
//
// EXTENDS THE SCHEDULE BRIEF'S DELIVERY PATH (schedule-brief-run.server.ts), which extends the
// standup's: a durable turn in the owner agent's DM with notify:"push" + internal:true, so the
// existing away-notification (journey send_push -> Android bridge) fires with no new sender.
//
// The pure half (edition, counts, the send/skip decision, the directive) takes its clock and rows
// as arguments; only `runPriorityCheck` touches the database, and only through dynamic imports.

import type { AgentId } from "../../data/agents";
import type { WidgetTaskRow } from "./widgets.server";
import type { BriefEdition } from "./schedule-brief.server";

/** Iris owns this. Her message carries an "Open Priorities" button (PRIORITY_CHECK_NAV_LINK). */
export const PRIORITY_CHECK_OWNER: AgentId = "iris-chase";

/** MORNING = ahead of grooming / auto-work; EVENING = ahead of the nightly scheduler. Picked by the
 *  schedule brief's own `editionForHour`, so the two twice-daily jobs share ONE rule for which half
 *  of the day an hour belongs to, and editing the hours in Settings keeps both editions. */
export type CheckEdition = BriefEdition;

export interface PriorityCheckSummary {
  edition: CheckEdition;
  /** Rows the widget will show — the same band the widget computes, not a second definition. */
  count: number;
  /** Due before today (local). The likeliest stale rows, so Iris names them. */
  overdue: number;
  blocked: number;
  /** Open, prioritised, and NOT started or scheduled — the "likely not to be scheduled" half of
   *  the owner's 2026-09-10 ask. */
  unscheduled: number;
  /** Titles of the first few rows, in the band's own order, so Iris can name them out loud (the
   *  message carries a button to the Priorities tab now, not the widget — owner, 2026-10-16). */
  top?: string[];
}

/** How many priorities Iris names before "and N more". */
export const PRIORITY_CHECK_NAMED = 3;

/** The button under Iris's message. Owner, 2026-10-16: "she can do so with a button that deep links
 *  to the priority tab in the app instead of embedded priority widget". */
export const PRIORITY_CHECK_NAV_LINK = { view: "priorities" as const, label: "Open Priorities" };

/** Count what the directive mentions. `todayKey` is yyyy-mm-dd in the user's zone; a row's due date
 *  is compared on its LOCAL date, via the same `localDateKey` the widget uses. */
export function summarizeBand(
  band: readonly WidgetTaskRow[],
  edition: CheckEdition,
  todayKey: string,
  dueKeyOf: (iso: string | null) => string | null,
): PriorityCheckSummary {
  let overdue = 0,
    blocked = 0,
    unscheduled = 0;
  for (const r of band) {
    const due = dueKeyOf(r.dueDate);
    if (due && due < todayKey) overdue++;
    if ((r.status ?? "").toUpperCase() === "BLOCKED") blocked++;
    if (!r.isScheduled && (r.status ?? "").toUpperCase() !== "DOING") unscheduled++;
  }
  const top = band.slice(0, PRIORITY_CHECK_NAMED).map((r) => r.title.trim()).filter(Boolean);
  return { edition, count: band.length, overdue, blocked, unscheduled, top };
}

/** The instruction Iris is handed. No widget and no tool call: the message ends with an "Open
 *  Priorities" BUTTON (attached from the payload's navLink, so it is there whatever the model does),
 *  and Iris names the top few priorities in her own spoken voice. */
const BUTTON_LINE = `An "${PRIORITY_CHECK_NAV_LINK.label}" button appears under your message and takes him straight to the Priorities tab.`;
/** Owner, 2026-10-16: "i should be able to reply to the priority message question with a list of items i
 *  want to work on" — the reply is handled by `focus_on` (focus.server.ts), so Iris says he can. */
const REPLY_LINE = `He can also just reply to you with what he wants to work on (e.g. "the deck, interview prep, gym") and you will start those — creating any that don't exist yet. Say that in a few words.`;
export function priorityCheckDirective(s: PriorityCheckSummary): string {
  // EMPTY BAND STILL SENDS (owner, 2026-10-15: "...and to confirm prioritization ahead of scheduling
  // the next day's build"). The 8pm run on 2026-10-15 found 0 priorities and sent NOTHING, so the
  // planner built tomorrow from its own scoring with no chance to confirm. Saying so IS the check.
  if (s.count === 0) {
    const consequence =
      s.edition === "evening"
        ? "Tonight's scheduler builds tomorrow's plan in a few hours, and with nothing prioritised it will pick from its own scoring."
        : "Grooming and the team's work today will pick from their own scoring, with nothing prioritised.";
    return (
      `SCHEDULED PRIORITY CHECK (${s.edition}). The owner has NO priorities set right now. ${consequence}\n\n` +
      `${BUTTON_LINE} ${REPLY_LINE}\n\n` +
      `Write TWO or THREE short spoken lines, starting "Hello Sir,": say there are no priorities set, what ` +
      `that means for ${s.edition === "evening" ? "tomorrow's plan" : "today"}, and ask whether there is anything ` +
      `he wants prioritised — he can set it with the button below. ` +
      `Do NOT call any tool, and do not invent anything not stated here.`
    );
  }
  const when =
    s.edition === "evening"
      ? "Tonight's scheduler builds tomorrow's plan from these priorities in a few hours."
      : "Grooming and the team's work today start from these priorities.";
  const flags: string[] = [];
  if (s.overdue) flags.push(`${s.overdue} past their due date`);
  if (s.blocked) flags.push(`${s.blocked} blocked`);
  if (s.unscheduled) flags.push(`${s.unscheduled} not yet scheduled`);
  const top = (s.top ?? []).slice(0, PRIORITY_CHECK_NAMED);
  const more = s.count - top.length;
  const named = top.length
    ? `Top ${top.length === 1 ? "priority" : `${top.length} in order`}: ${top.map((t) => `"${t}"`).join(", ")}` +
      `${more > 0 ? `, and ${more} more` : ""}.`
    : "";
  return (
    `SCHEDULED PRIORITY CHECK (${s.edition}). The owner has ${s.count} open priorit${s.count === 1 ? "y" : "ies"}` +
    `${flags.length ? ` — ${flags.join(", ")}` : ""}. ${when}${named ? ` ${named}` : ""}\n\n` +
    `${BUTTON_LINE} ${REPLY_LINE}\n\n` +
    `Write TWO or THREE short spoken lines, starting "Hello Sir,": name the top priorities above in plain ` +
    `words${more > 0 ? " and say how many more there are" : ""}, ask whether they are still right, and say ` +
    `he can confirm, reorder or fix anything stale with the button below. ` +
    `${flags.length ? "Mention the flagged counts above in a few words. " : ""}` +
    `Do NOT call any tool, do not list anything beyond the names given, and do not invent anything not stated here.`
  );
}

/** Idempotency: one push per edition per local day. A retry or overlapping tick re-uses the id, so
 *  `enqueueTurn` returns not-fresh and nothing is sent twice. `runId` only marks a deliberate manual
 *  re-run. The `routine-`-safe shape matters: it must not match `^u-\d+$` or `xapp-`, or the
 *  directive would render as a "You" bubble (docs/plan-agent-routines.md). */
export function priorityCheckTurnId(edition: CheckEdition, todayKey: string, runId?: string): string {
  return `priority-check-${edition}-${todayKey}${runId ? `-${runId}` : ""}`;
}

export interface PriorityCheckResult {
  ok: boolean;
  edition?: CheckEdition;
  todayKey?: string;
  summary?: PriorityCheckSummary;
  delivered?: boolean;
  /** No longer produced: an empty band is sent as an "no priorities set" check (2026-10-15).
   *  Kept so existing callers that read the field still type-check. */
  skipped?: "empty";
  turnId?: string;
  directive?: string;
  error?: string;
}

/**
 * Run one edition for one user. NEVER THROWS — every failure is an ok:false return, like every
 * scheduled job here; a throwing job would lose the whole heartbeat tick for the others.
 */
export async function runPriorityCheck(
  caller: { entra_email: string },
  opts: { timeZone?: string; edition?: CheckEdition; dryRun?: boolean; runId?: string; nowMs?: number } = {},
): Promise<PriorityCheckResult> {
  try {
    const { DEFAULT_TZ } = await import("../identity/scheduling-config.server");
    const { safeTimeZone, localDateKey, buildPrioritiesBand } = await import("./widgets.server");
    const { localHour, editionForHour } = await import("./schedule-brief.server");
    const tz = safeTimeZone(opts.timeZone?.trim() || DEFAULT_TZ);
    const nowMs = opts.nowMs ?? Date.now();
    const edition = opts.edition ?? editionForHour(localHour(nowMs, tz));
    const todayKey = localDateKey(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);

    const { getBoardTasks, getWeekOrder } = await import("./tasks.server");
    const rows = await getBoardTasks(caller.entra_email);
    const order = await getWeekOrder(caller.entra_email).catch(() => [] as string[]);
    // The SAME band the widget will render — one definition, so the count in the message can never
    // disagree with the card under it.
    const band = buildPrioritiesBand(rows, tz, nowMs, order);
    const summary = summarizeBand(band, edition, todayKey, (iso) => localDateKey(iso, tz));
    const directive = priorityCheckDirective(summary);
    const turnId = priorityCheckTurnId(edition, todayKey, opts.runId);
    const base: PriorityCheckResult = { ok: true, edition, todayKey, summary, turnId };

    if (opts.dryRun) return { ...base, delivered: false, directive };
    // An EMPTY band is still sent (see priorityCheckDirective): "nothing prioritised" is exactly the
    // thing the owner needs to hear before the planner runs. It used to return skipped:"empty" here.

    const owner = PRIORITY_CHECK_OWNER;
    const payload = {
      text: directive,
      huddleId: `dm-${owner}`,
      scope: "one-to-one",
      members: [owner],
      targetAgentId: owner,
      history: [],
      // Same router block every scheduled job ships with today (schedule-brief, standup, digest).
      router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
      // journey disabled: this turn has no business writing the board; the widget's own buttons do.
      agents: { [owner]: { backend: "openai", journey: { enabled: false } } },
      timeZone: tz,
      caller,
      notify: "push",
      internal: true,
      // The "Open Priorities" button, attached to Iris's reply by the turn runner (not by the model).
      navLink: PRIORITY_CHECK_NAV_LINK,
    };
    const { enqueueTurn } = await import("./turns.server");
    const fresh = await enqueueTurn(turnId, `dm-${owner}`, caller.entra_email, payload);
    if (fresh) {
      const { runTurnById } = await import("../huddle.functions");
      await runTurnById(turnId);
    }
    return { ...base, delivered: !!fresh };
  } catch (err) {
    return { ok: false, delivered: false, error: err instanceof Error ? err.message : String(err) };
  }
}
