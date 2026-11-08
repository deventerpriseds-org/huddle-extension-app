// WHAT:       Server half of job-check.ts: arm a delayed check after a long-running journey tool call, and
//             run that check when the per-minute drain fires it.
// WHY:        see job-check.ts (rebuild_schedule > 30s tool cap, 2026-11-07).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/job-check.test.ts.
import {
  JOB_CHECK_KIND,
  jobCheckDelayMs,
  jobCheckDirective,
  jobCheckId,
  nextJobCheck,
  parseJobCheckText,
  type JobCheckMeta,
} from "./job-check";

/**
 * Called right after a journey tool returns, on every path that dispatches journey tools (text OpenAI,
 * text Lovable, voice). Arms a chat.reminders row of kind 'job-check' when the tool was a long-running
 * START (or a not-finished status inside a job-check turn). Best-effort: never throws, never blocks the
 * reply. Returns the armed check, or null.
 */
export async function armJobCheck(args: {
  toolName: string;
  output: unknown;
  huddleId: string | undefined | null;
  agentId: string | undefined | null;
  caller: { entra_email?: string | null } | undefined | null;
  current?: { attempt: number } | null;
  nowMs?: number;
}): Promise<JobCheckMeta | null> {
  try {
    const meta = nextJobCheck(args.toolName, args.output, args.current);
    if (!meta || !args.huddleId || !args.agentId) return null;
    let email: string | null = null;
    try {
      const { resolveTaskEmail } = await import("../journey/identity");
      email = (await resolveTaskEmail(args.caller as never)) ?? args.caller?.entra_email ?? null;
    } catch {
      email = args.caller?.entra_email ?? null;
    }
    const { createReminder } = await import("./turns.server");
    await createReminder({
      id: jobCheckId(meta),
      userEmail: email,
      huddleId: args.huddleId,
      agentId: args.agentId,
      text: JSON.stringify(meta),
      kind: JOB_CHECK_KIND,
      dueAtMs: (args.nowMs ?? Date.now()) + jobCheckDelayMs(meta.attempt),
    });
    return meta;
  } catch {
    return null; // duplicate id (already armed) or DB hiccup — the user can still just ask
  }
}

/**
 * The drain's handler for a due job-check row: enqueue a REAL durable turn in the same DM and run it now
 * (the same inline pattern as the task-reminder close-out). No push of its own: the turn's reply carries
 * the normal away-notification. Returns true when it handled the row.
 */
export async function fireJobCheck(r: {
  id: string;
  user_email: string | null;
  huddle_id: string;
  agent_id: string | null;
  text: string;
}): Promise<boolean> {
  const meta = parseJobCheckText(r.text);
  if (!meta || !r.agent_id || !r.user_email) return true; // malformed: swallow, never render as a reminder
  const turnId = `jobcheck-turn-${r.id}`.slice(0, 160);
  const { enqueueTurn } = await import("./turns.server");
  const fresh = await enqueueTurn(turnId, r.huddle_id, r.user_email, {
    text: jobCheckDirective(meta),
    huddleId: r.huddle_id,
    scope: "one-to-one",
    members: [r.agent_id],
    targetAgentId: r.agent_id,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [r.agent_id]: { backend: "openai", journey: { enabled: true } } },
    caller: { entra_email: r.user_email },
    notify: "push",
    internal: true,
    jobCheck: { tool: meta.tool, since: meta.since, attempt: meta.attempt },
  });
  if (fresh) {
    const { runTurnById } = await import("../huddle.functions");
    await runTurnById(turnId);
  }
  return true;
}
