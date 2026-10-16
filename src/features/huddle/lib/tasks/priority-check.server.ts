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

/** Iris owns this — her DM already carries the docked priorities widget. */
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
}

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
  return { edition, count: band.length, overdue, blocked, unscheduled };
}

/** The instruction Iris is handed. Facts are counts only; the widget carries the rows, so the model
 *  is told NOT to list them (the WIDGET_SYSTEM_HINT rule) and MUST call the tool — Phase 0 proved a
 *  directive saying so overrides the don't-volunteer rule at tools.ts. */
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
      `Call show_priorities_widget now — presenting the widget IS the point of this message, do not skip ` +
      `the tool call. Then write ONE or TWO short lines in your own voice saying there are no priorities set, ` +
      `what that means for ${s.edition === "evening" ? "tomorrow's plan" : "today"}, and asking whether there is ` +
      `anything he wants prioritised — he can add it right there from the card. ` +
      `Do not call any other tool, and do not invent anything not stated here.`
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
  return (
    `SCHEDULED PRIORITY CHECK (${s.edition}). The owner has ${s.count} open priorit${s.count === 1 ? "y" : "ies"}` +
    `${flags.length ? ` — ${flags.join(", ")}` : ""}. ${when}\n\n` +
    `Call show_priorities_widget now — presenting the widget IS the point of this message, do not skip ` +
    `the tool call. Then write ONE or TWO short lines in your own voice asking whether these are still ` +
    `right, and that anything stale can be fixed right there on the card (done, park, move to today). ` +
    `${flags.length ? "Mention the flagged counts above in a few words. " : ""}` +
    `Do NOT list the tasks in text, do not call any other tool, and do not invent anything not stated here.`
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
