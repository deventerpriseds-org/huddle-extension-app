// WHAT:       The synchronous turn deadline, and the shorter one a ceremony BARGE gets.
// WHY:        The browser abandons a barge answer at 30s (MeetingBar.tsx runBargeSequence races
//             sendHuddleMessage against a 30_000ms timer) but the server allowed every synchronous turn
//             36s. A barge answer landing between ~30s and 36s was finished on the server and thrown away
//             by the client: the user heard nothing. Owner-approved option (a), 2026-11-16: cap the
//             SERVER at 25s for barges only, so the server always answers inside the client's window
//             (5s headroom for the network). Normal turns keep 36s.
// SUPERSEDES: the inline `TURN_DEADLINE_MS = 36_000` in huddle.functions.ts runHuddleTurn.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/DIAG-uat-long-task-barge.md (branch claude_diag-uat-long-task-barge):
//             failing barges had no `barge_route` row -- the server was still working at +31.8s.
//             Test: bun scripts/barge-deadline.test.ts
//
// Dependency-free on purpose so the offline test can import it without the server graph.

/** Synchronous (non-chunked) turn deadline: under the ~45s hosting request ceiling. */
export const TURN_DEADLINE_MS = 36_000;

/** Ceremony barge deadline. MUST stay below the client's 30s barge timer in MeetingBar.tsx. */
export const BARGE_TURN_DEADLINE_MS = 25_000;

/** A 1:1 has one responder and no wave to protect, so it gets (nearly) the whole hosting request. */
export const ONE_TO_ONE_AGENT_BUDGET_MS = 40_000;

/** The whole-turn deadline runHuddleTurn bounds its agents by. */
export function turnDeadlineMs(opts: {
  chunked: boolean;
  chunkBudgetMs: number;
  ceremonyBarge?: boolean;
}): number {
  if (opts.chunked) return opts.chunkBudgetMs;
  return opts.ceremonyBarge ? BARGE_TURN_DEADLINE_MS : TURN_DEADLINE_MS;
}

/** One agent's budget inside runBounded. A barge never takes the 1:1 allowance: the client still
 *  gives up at 30s whatever the scope. Today every barge is sent with scope "group". */
export function agentBudgetMs(opts: {
  scope: string;
  ceremonyBarge?: boolean;
  deadlineMs: number;
}): number {
  if (opts.ceremonyBarge) return opts.deadlineMs;
  return opts.scope === "one-to-one" ? ONE_TO_ONE_AGENT_BUDGET_MS : opts.deadlineMs;
}
