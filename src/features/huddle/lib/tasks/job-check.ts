// WHAT:       Report the result of a LONG-RUNNING journey job (today: rebuild_schedule) back into the 1:1 it
//             was started from, a few minutes later, as a normal agent reply.
// WHY:        2026-11-07 the owner asked Iris to re-run the scheduling job. The rebuild takes 66-142s
//             (journey activity_log nightly_schedule_built.processing_ms, last 3 days), but every agent tool
//             call is capped at 30s (huddle.functions.ts TOOL_TIMEOUT_MS) under a ~45s hosting ceiling, so
//             Iris said "timed out after 30 seconds" while the job actually finished (chat.pending_turns
//             u-1794079732903). Owner: "It has to be able to run such a job and get around the 30 second
//             timeout... I thought we landed an approach for long running jobs".
//             The landed approach: never wait inside one request. journey now STARTS the job in the
//             background and returns at once; this module arms a check that rides the EXISTING delayed
//             path -- a chat.reminders row (kind 'job-check') -> the per-minute drain (fireDueReminders) ->
//             a REAL durable turn in the same DM (enqueueTurn + runTurnById), exactly like the task-
//             reminder close-out. No new table, no new sender, no new cron.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/job-check.test.ts; journey-voice _shared/rebuild-schedule.ts (start/status contract).

/** chat.reminders.kind for an internal job check. Never shown to the user as a reminder. */
export const JOB_CHECK_KIND = "job-check";

/** Journey tools whose start returns before the work is done and that support action:"status". */
export const LONG_RUNNING_JOURNEY_TOOLS = new Set(["rebuild_schedule"]);

export const MAX_JOB_CHECK_ATTEMPTS = 3;

/** Delay before check N. The first covers a typical run (66-142s measured); later ones back off. */
export function jobCheckDelayMs(attempt: number): number {
  return attempt <= 1 ? 150_000 : attempt === 2 ? 120_000 : 240_000;
}

export interface JobCheckMeta {
  tool: string;
  since: string;
  scope?: string;
  attempt: number;
}

/** Find a field anywhere in a journey tool output (execute-tool wraps results a level or two deep). */
function pick(obj: any, key: string, depth = 0): any {
  if (!obj || typeof obj !== "object" || depth > 3) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = pick(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type JobOutcome =
  | { kind: "started"; since: string; scope?: string }
  | { kind: "not_finished"; since: string }
  | { kind: "other" };

/** Classify a long-running tool's output: a fresh start, a still-running status, or anything else. */
export function classifyJobOutput(output: unknown): JobOutcome {
  let obj: any = output;
  if (typeof output === "string") {
    try {
      obj = JSON.parse(output);
    } catch {
      return { kind: "other" };
    }
  }
  const startedAt = pick(obj, "started_at");
  if (pick(obj, "started") === true && typeof startedAt === "string") {
    const scope = pick(obj, "scope");
    return { kind: "started", since: startedAt, scope: typeof scope === "string" ? scope : undefined };
  }
  const since = pick(obj, "since");
  if (pick(obj, "finished") === false && typeof since === "string") return { kind: "not_finished", since };
  return { kind: "other" };
}

/**
 * What to arm after a long-running tool call, or null. A start arms attempt 1. A status that says
 * "not finished" arms the NEXT attempt, but only inside a job-check turn and only up to the cap — so a
 * check can never loop forever, and an ordinary "is it done?" question from the user arms nothing extra.
 */
export function nextJobCheck(
  toolName: string,
  output: unknown,
  current: { attempt: number } | null | undefined,
): JobCheckMeta | null {
  if (!LONG_RUNNING_JOURNEY_TOOLS.has(toolName)) return null;
  const o = classifyJobOutput(output);
  if (o.kind === "started") return { tool: toolName, since: o.since, scope: o.scope, attempt: 1 };
  if (o.kind === "not_finished" && current && current.attempt < MAX_JOB_CHECK_ATTEMPTS) {
    return { tool: toolName, since: o.since, attempt: current.attempt + 1 };
  }
  return null;
}

export function jobCheckId(meta: JobCheckMeta): string {
  const key = `${meta.tool}-${meta.since}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `jobcheck-${key}-${meta.attempt}`.slice(0, 120);
}

export function parseJobCheckText(text: string): JobCheckMeta | null {
  try {
    const m = JSON.parse(text);
    if (m && typeof m.tool === "string" && typeof m.since === "string" && Number.isInteger(m.attempt)) {
      return { tool: m.tool, since: m.since, scope: typeof m.scope === "string" ? m.scope : undefined, attempt: m.attempt };
    }
  } catch {
    /* not a job check */
  }
  return null;
}

/** The directive the follow-up turn runs on. Internal: the user never sees this text. */
export function jobCheckDirective(meta: JobCheckMeta): string {
  const last = meta.attempt >= MAX_JOB_CHECK_ATTEMPTS;
  return (
    `FOLLOW-UP CHECK (system, not a user message). Earlier in this 1:1 you started a schedule rebuild for ` +
    `the user (${meta.tool}, started_at ${meta.since}). Call ${meta.tool} with action "status" and since ` +
    `"${meta.since}" — do NOT start a new rebuild.\n` +
    `- If it has finished: tell the user in one or two short lines that the rebuild is done and how many ` +
    `tasks were placed, then read the schedule and list what is now on it for the day(s) rebuilt.\n` +
    `- If it failed: say so plainly in one line, with the reason.\n` +
    (last
      ? `- If it still has not finished: say in one line that it is taking longer than usual and they can ` +
        `check the Schedule tab or ask you again later. Do not promise another check.`
      : `- If it has not finished yet: say in ONE short line that it is still running and you will check ` +
        `again in a few minutes.`)
  );
}
