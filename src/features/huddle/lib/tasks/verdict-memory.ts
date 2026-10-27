// WHAT:       Short-lived memory of the owner's LAST answer to the produce-vs-quick gate, per
//             huddle, so a question they already answered is not asked again a minute later.
// WHY:        The gate is stateless past the single reply. Its pending row is
//             `PRIMARY KEY (user_email, huddle_id)` and EVERY verdict DELETEs it
//             (huddle.functions.ts: quick -> clear, produce -> clear, cancel -> clear), so the next
//             difficulty>=3 message in the same 1:1 asked from scratch. Only `data.modelEscalate`
//             (per-request) and `hasGreenLit` (a go-ahead PHRASE in the last few user lines)
//             suppressed it — and measured this session, `isGreenLight("produce")` is FALSE, so
//             answering the gate with the exact word it asked for did not suppress anything.
//             Owner: "already said go" is not remembered.
// SUPERSEDES: nothing -- it EXTENDS the existing chat.deep_confirm row rather than adding a table.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/VERIFY-escalated-dead-end-1.md CLAIM 5; scripts/verdict-memory.test.ts
//
// NO NODE IMPORTS: `deep-confirm.server.ts` (a pg module) and `huddle.functions.ts` both import
// this, and it must stay runnable by `bun scripts/verdict-memory.test.ts` with no database. The
// STORE lives in deep-confirm.server.ts (same table, same row, two extra columns); this file is the
// pure decision so it can be proven offline.

/** The two verdicts worth remembering. `cancel` is deliberately absent — see below. */
export type RememberedVerdict = "produce" | "quick";

/**
 * How long the owner's last verdict keeps answering the question for them.
 *
 * THIRTY MINUTES, and this is a judgement call with a safe default rather than a measured
 * constant — **it is meant to be tuned.** The reasoning: the failure being fixed is a re-ask
 * "a minute later" inside one continuous working conversation, and half an hour comfortably covers
 * a sitting at the keyboard. Going much longer starts answering for a user who has moved on to a
 * different subject entirely and might genuinely want the other shape; going much shorter leaves
 * the original complaint half-fixed. The 2h pending expiry already in the store is the other
 * anchor: a verdict should not outlive an unanswered ask, so this is deliberately well inside it.
 *
 * It is refreshed on every verdict, so a conversation that keeps saying "produce" keeps the memory
 * warm rather than hitting a hard cliff mid-flow.
 */
export const VERDICT_MEMORY_MS = 30 * 60_000;

/** Parse whatever came out of the DB column into a verdict we are willing to act on. */
export function asRememberedVerdict(value: unknown): RememberedVerdict | null {
  return value === "produce" || value === "quick" ? value : null;
}

/**
 * Should a remembered verdict answer THIS fresh deep ask, instead of asking again?
 *
 * Returns the verdict to apply, or null to ask normally. Null on every unusable input — an unknown
 * verdict string, a missing timestamp, a NaN, or a timestamp in the future (a clock skew must not
 * grant an unbounded suppression window).
 *
 * CANCEL IS NEVER REMEMBERED, deliberately. "Park it" is an answer about one particular ask, not a
 * standing instruction to stop asking; suppressing a later genuine question because the user once
 * said "never mind" would be a worse failure than the re-ask this fixes. The store keeps that true
 * structurally — cancel DELETEs the row, taking any remembered verdict with it.
 */
export function verdictToApply(
  verdict: unknown,
  atMs: number | null | undefined,
  nowMs: number,
): RememberedVerdict | null {
  const v = asRememberedVerdict(verdict);
  if (!v) return null;
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const age = nowMs - atMs;
  if (age < 0) return null;
  if (age > VERDICT_MEMORY_MS) return null;
  return v;
}
