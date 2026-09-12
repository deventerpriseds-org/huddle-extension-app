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
 */
function isNegatedOrAsked(n: string): boolean {
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
