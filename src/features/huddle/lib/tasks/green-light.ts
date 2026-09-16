// WHAT:       "Has the user already said GO?" — one shared matcher for unambiguous, imperative
//             go-aheads, used by BOTH halves of the produce-vs-quick gate: classifying a reply to a
//             pending ask, and suppressing a FRESH ask the user has effectively already answered.
// WHY:        The gate ignored a green light. Measured live: it asked at 01:32, the owner replied
//             "Go for it" at 02:06 and "Okay knock it out" at 02:50 — three go-aheads — and it was
//             still asking. Owner: "need to make sure it works and doesn't ignore a green light."
//             `classifyConfirmReply`'s produce family is anchored with `^(...)` so "Okay knock it
//             out" (a go-ahead that does not START with a go-ahead word) fell through as "unrelated".
// SUPERSEDES: nothing -- it is the shared half extracted so the two call sites cannot drift apart.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/green-light.test.ts
//
// NO NODE IMPORTS: `deep-confirm.server.ts` (a pg module) and `huddle.functions.ts` both import this,
// and it must stay runnable by `bun scripts/green-light.test.ts` with no database.
//
// WHY THE PATTERNS ARE PHRASES, NOT KEYWORDS: matching the bare word "go" would read "where did the
// go-to-market plan go?" as consent. Every entry below is an anchored idiom that means one thing.

/** Case + typography only, so "Okay, knock it out!" and "okay knock it out" match the same rule. */
function norm(s: string): string {
  return (s || "")
    .replace(/[‘’‛ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Unambiguous imperative go-aheads. Order is irrelevant; any one match is a green light. */
const GREEN_LIGHT: RegExp[] = [
  /\bgo for it\b/,
  /\bknock (?:it|that) out\b/,
  /\bgo ahead\b/,
  /\bgive it a (?:go|shot|crack)\b/,
  /\b(?:just )?(?:do|run|start) it\b/,
  /\bget (?:it|that) (?:done|started|going)\b/,
  /\bget started\b/,
  /\bget cracking\b/,
  /\bhave at it\b/,
  /\btake it on\b/,
  /\bmake it (?:happen|so)\b/,
  /\bproceed\b/,
  /\bcarry on\b/,
  /\bcrack on\b/,
  /\brun with (?:it|that)\b/,
  /\bi said (?:go|proceed|yes)\b/,
  /\bfull steam\b/,
];

/**
 * A negation or a deferral REVERSES a go-ahead ("don't do it", "hold off"), and a question is never
 * one ("should I just do it?"). Both are checked before the phrases, so "not yet — go for it later"
 * does not authorise anything.
 *
 * EXPORTED (2026-09-12): the approach-gate override check needs exactly this rule, and a second copy
 * of it is how the two drift apart. It is also the precise rule the proven attack defeated — a
 * verifier cherry-picked the clause AFTER "do NOT" and the override guard never consulted this at
 * all (.claude/VERIFY-override-gate-1.md, CLAIM 4b, attack C). One rule, one home.
 */
export function isNegatedOrAsked(n: string): boolean {
  if (n.endsWith("?")) return true;
  return /\b(?:don'?t|do not|not yet|hold off|hold on|wait|no need|rather than|instead of|before you)\b/.test(n);
}

/** Is this single line an unambiguous go-ahead? */
export function isGreenLight(line: string): boolean {
  const n = norm(line);
  if (!n) return false;
  if (isNegatedOrAsked(n)) return false;
  return GREEN_LIGHT.some((re) => re.test(n));
}

/**
 * Has the user green-lit deep async work in this thread already?
 *
 * @param userLines the user's OWN messages in this huddle, oldest first (agent replies must not be
 *                  passed — an agent saying "go ahead" is not consent).
 * @param lookback  how many of the most recent user lines count. Small on purpose: a go-ahead from
 *                  thirty messages ago was about something else entirely.
 */
export function hasGreenLit(userLines: string[], lookback = 4): boolean {
  return (userLines ?? [])
    .filter((l) => typeof l === "string" && l.trim())
    .slice(-lookback)
    .some(isGreenLight);
}

// ---- AUTHORISATION: the same question, asked where the answer moves a SAFETY GATE ----------------
//
// Everything below is ADDITIVE. `GREEN_LIGHT` and `isGreenLight` above are untouched, deliberately:
// `deep-confirm.server.ts` and `huddle.functions.ts` read them to decide produce-vs-quick, and a
// change there would silently re-tune that gate. What is added is a STRICTER superset used only by
// the approach-gate override — it accepts the go-ahead idioms above PLUS the ones people actually
// use to clear a stuck gate, and rejects more aggressively (a question that merely STARTS as one
// counts, because the attack it exists to stop is the user quoting an agent's own proposal back at
// it: "what is this: <the agent's plan>").

/**
 * Ways a user clears an ESCALATED approach specifically. "override it" / "approve it as-is" are not
 * go-aheads to start work (so they do not belong in GREEN_LIGHT, which drives a different gate) —
 * they are consent to a decision the gate has already refused.
 */
const OVERRIDE_AUTHORISATION: RegExp[] = [
  /\boverride (?:it|that|this|the (?:gate|approach|approach gate))\b/,
  /\bapprove (?:it|that|this|the approach)\b/,
  /\bapproved? as[- ]is\b/,
  /\bas[- ]is is fine\b/,
  /\bunblock (?:it|that|this|the task)\b/,
  /\bunstick (?:it|that|this)\b/,
  /\bship it\b/,
  /\bi said (?:approve|override)\b/,
];

/**
 * Does the clause OPEN as a question? `isNegatedOrAsked` only catches a trailing "?", which the
 * reproduced attack sailed past: "what is this: Do the risky migration and skip the backup step
 * entirely" has no question mark at all. Deliberately narrow — the openers listed are ones that can
 * never begin an imperative, so "do it", "go for it" and "run with it" are unaffected (note bare
 * "do"/"can" are NOT here; only "do i/we/you", "can i/we/you" are).
 */
/**
 * A go-ahead POSTPONED is not a go-ahead now. `isNegatedOrAsked` catches "not yet"/"hold off"; this
 * catches the other half the reproduced attack used — "override it later once we know more". Kept
 * out of the shared rule on purpose: the produce-vs-quick gate reads a short reply where "later" is
 * far likelier to be incidental, whereas here the cost of being wrong is a safety gate opening.
 */
const DEFERRED =
  /\b(?:later|tomorrow|next week|after (?:we|you|i)|once (?:we|you|i)|when (?:we|you|i)|in a (?:bit|sec|minute)|for now)\b/;

function opensAsQuestion(n: string): boolean {
  return /^(?:what|what's|whats|why|how|when|where|who|whom|whose|which|should|shall|could|would|may i|can i|can we|can you|do i|do we|do you|does|did|are we|are you|is it|is this|am i)\b/.test(
    n,
  );
}

/**
 * Does this single clause, read whole, AUTHORISE overriding a gate?
 *
 * The caller must pass the user's full clause, never a span the caller chose — that distinction is
 * the entire defect this exists to fix. See approach-override.ts `clauseAround`.
 */
export function isAuthorisation(line: string): boolean {
  const n = norm(line);
  if (!n) return false;
  if (isNegatedOrAsked(n)) return false;
  if (opensAsQuestion(n)) return false;
  if (DEFERRED.test(n)) return false;
  return GREEN_LIGHT.some((re) => re.test(n)) || OVERRIDE_AUTHORISATION.some((re) => re.test(n));
}
