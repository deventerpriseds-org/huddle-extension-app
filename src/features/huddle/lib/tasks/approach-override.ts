// WHAT:       The re-grade bound for an escalated approach gate. Pure functions, no I/O, so the guard
//             is unit-testable and mutation-provable offline (same shape and reason as
//             cross-app/turn-gate.ts).
// WHY:        `approach_status='escalated'` was terminal — approach-gate.server.ts returned before the
//             grader ran, so a task could never be unstuck. Removing that short-circuit removed the
//             thing that bounded the grader loop; this file is its replacement.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/approach-override.test.ts; .claude/AC-override-gate.md.
//
// ---------------------------------------------------------------------------------------------------
// THE CONSENT CLASSIFIER THAT USED TO LIVE HERE IS GONE. DO NOT BRING IT BACK. (2026-09-12)
//
// `verifyOwnerQuote` tried to decide, from the owner's free text, whether their words MEANT consent to
// override a specific task: a model passed `owner_quote`, the server located it in a real user turn,
// expanded it to its clause, ran two word lists over it (negation/deferral, then go-ahead idioms) and
// bound it to a task by id, title-phrase or DM channel.
//
// It was refuted three times by three independent adversarial passes, which found three NON-OVERLAPPING
// sets of holes in those two small lists — while all 13 suites stayed green throughout, because no
// suite was shaped like the attacks:
//   - DM-ambiguity-of-one: with exactly one escalated task (the ORDINARY case) any unrelated go-ahead
//     bound. "Sure, go ahead and book the conference room for Friday's offsite" -> ok:true.
//   - negation gaps: "Never approve that particular approach without more testing." -> ok:true.
//     "not now" -> ok:true. Both are near-misses of lists that exist to catch exactly them.
//   - clean-imperative paste: the owner quoting an agent's own proposal back, WITH attribution and an
//     explicit hedge ("Sam suggested ... not sure that's wise though") -> ok:true.
//   - title-phrase collision: a genuine authorisation about the weekly NEWSLETTER unblocked a task
//     titled "Send the weekly report", because binding scanned the whole utterance, not the clause.
// (.claude/VERIFY-override-gate-1.md, -2.md, -2-attacks.md — all three are committed on this branch.)
//
// The owner's stated precondition was "prevent self override by agent". A classifier over ordinary
// English cannot deliver that, and each pass finding a DIFFERENT set is the evidence: the method
// enumerates the ways a person can decline, attribute or postpone, which is open-ended by construction.
// Adding words to the lists is the failure mode, not the fix.
//
// What replaced it is structural, not smarter, and it comes in TWO parts (both 2026-09-12):
//   1. A model may only REQUEST an override (`request_approach_override` -> `requestApproachOverride`).
//      That call cannot grant one; the owner tapping "Approve anyway" can.
//   2. A model may also RELAY an authorisation the owner has already given — `override_approach_gate`
//      -> `overrideApproachFromTurnPair` — by passing TURN IDS. The server fetches the owner's turn and
//      the escalation turn it answered out of `chat.pending_turns` itself, requires the latter to BE
//      this task's notice, and hands the pair to this gate's own grader.
// Deleting the model path outright (part 1 alone) was an OVER-correction: "I never asked to prevent
// self override!" What must never come back is a WORD LIST over model-supplied text. In neither part
// is any caller-chosen string an input to the decision.
// See .claude/BUILD-override-request-then-tap.md and .claude/BUILD-override-turn-pair.md.
// ---------------------------------------------------------------------------------------------------

// ---- re-grading bound ----------------------------------------------------------------------------

/**
 * How many grader calls a task may EVER consume, given its configured per-task cap.
 *
 * Removing the `escalated` short-circuit removes the thing that used to bound the grader loop
 * (escalated was terminal, so the grader could never run again). This is its replacement, and it
 * reuses `approach_revision_count` rather than adding a column: an escalated task carries
 * `caps.approach - 1`, and each re-grade attempt is counted BEFORE it is graded, so a grader that
 * errors or times out still consumes one. At the ceiling the only way forward is an owner override.
 */
export function regradeCeiling(capApproach: number): number {
  const cap = Number.isFinite(capApproach) && capApproach > 0 ? Math.floor(capApproach) : 3;
  return cap * 2;
}

/** May an already-escalated task be graded again? */
export function mayRegradeEscalated(revisionCount: number, capApproach: number): boolean {
  return (revisionCount ?? 0) < regradeCeiling(capApproach);
}
