// WHAT:       The anti-self-override guard: decides whether a quoted authorisation ("I said proceed")
//             genuinely came from the OWNER, by locating it in a recent real user turn. Pure
//             functions, no I/O, so every guard here is unit-testable and mutation-provable offline
//             (same shape and the same reason as cross-app/turn-gate.ts).
// WHY:        `approach_status='escalated'` was terminal — approach-gate.server.ts returned before the
//             grader ran, so the owner could not unstick a task and telling an agent "I said proceed"
//             had nowhere to land. The override that fixes that is a deliberate hole in a safety gate,
//             so the owner asked for the one check that makes the hole safe: "can't we make the
//             verifier require my text from the transcript as an input to override to prevent self
//             override by agent?" The model supplies the quote; THIS decides whether it is real.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/approach-override.test.ts; .claude/AC-override-gate.md (AC-O1's objection —
//             "what stops an AGENT calling it to unblock itself?" — is what this file answers).
//
// NO NODE IMPORTS, deliberately: this must stay runnable by `bun scripts/approach-override.test.ts`
// with no database, which is what makes the guard cheap to mutation-prove.
//
// THE THREAT MODEL, because it decides every constant below. The adversary is not a stranger; it is
// an AGENT IN THIS APP holding the owner's tools, trying to unblock ITSELF. It can call the tool with
// any string it likes. What it cannot do is put words in the owner's mouth: user turns are written by
// `enqueueTurn` at submit time, and the cross-app door authenticates its caller with a shared secret
// and resolves the acting subject from server-held config that no request byte can influence. So the
// guard's only job is: does this text ACTUALLY occur in something the owner said, recently, verbatim?

import { isUserTurn } from "../turn-identity";

/** One candidate utterance, projected from `chat.pending_turns`. */
export interface UserUtterance {
  /** `chat.pending_turns.id` — the shape is what proves who was talking (see isUserTurn). */
  id: string;
  /** `payload.text`. For an AGENT-INITIATED turn this is an internal directive, never the user. */
  text: string;
  /** `updated_at` in epoch ms. */
  updatedMs: number;
}

/**
 * How far back an authorisation stays good. The owner's own live case had the go-aheads 34 and 78
 * minutes after the ask; autowork's cadence is 9/13/17, so a day covers "I told it last night, it
 * acted this morning" while stopping a year-old "go for it" from authorising anything today.
 */
export const QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The floor that stops a generic affirmation authorising anything. "ok" / "yes" / "go ahead" are
 * things the owner says many times a day about anything at all, so finding one in the transcript is
 * no evidence at all that they authorised THIS. Both conditions must hold: characters alone would
 * admit one long word, words alone would admit "ok ok ok ok".
 */
export const QUOTE_MIN_CHARS = 24;
export const QUOTE_MIN_WORDS = 4;

/**
 * Typography-only normalisation. A model re-typing the owner's words will straighten a curly
 * apostrophe, lose a double space, or turn an em-dash into a hyphen — none of which changes what was
 * said. NOTHING BEYOND TYPOGRAPHY is normalised: no stemming, no stopword removal, no token-set
 * similarity. Fuzzy matching is for RANKING, never for AUTHORISING — a similarity score drops
 * exactly the words ("not", "don't") that decide whether the sentence authorises anything.
 */
export function normalizeQuote(s: string): string {
  return s
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[   ]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Word count of an already-normalised quote. */
function wordCount(normalized: string): number {
  return normalized ? normalized.split(" ").filter(Boolean).length : 0;
}

/**
 * Is this quote substantial enough to authorise anything at all? Checked BEFORE any transcript read,
 * so a one-word quote can never even be looked for.
 */
export function quoteIsSubstantial(normalized: string): boolean {
  return normalized.length >= QUOTE_MIN_CHARS && wordCount(normalized) >= QUOTE_MIN_WORDS;
}

export type QuoteVerdict =
  | { ok: true; turnId: string; matchedMs: number }
  | { ok: false; reason: "too-short" | "not-found" };

/**
 * THE GUARD. Find a genuine user utterance, inside the recency window, that CONTAINS the quote.
 *
 * Three filters, and each one is load-bearing:
 *  1. `isUserTurn(id)` — an agent-initiated turn (autowork confirm-intent, a groom pass, an owner
 *     follow-up) stores its INTERNAL DIRECTIVE in the same `payload.text` field. Without this filter
 *     an agent could quote back a directive it caused to be written and call it the owner's words.
 *  2. the age window — an authorisation is about a moment, not a standing grant.
 *  3. contiguous substring of the normalised text — the owner's sentence, verbatim, allowing the
 *     model to have retyped its punctuation.
 *
 * Returns the matching turn id so the caller can RECORD which utterance authorised the override; a
 * marker with no provenance is not an audit trail.
 */
export function verifyOwnerQuote(
  rawQuote: string,
  utterances: UserUtterance[],
  nowMs: number,
): QuoteVerdict {
  const needle = normalizeQuote(rawQuote ?? "");
  if (!quoteIsSubstantial(needle)) return { ok: false, reason: "too-short" };
  const floor = nowMs - QUOTE_MAX_AGE_MS;
  for (const u of utterances) {
    if (!u || typeof u.text !== "string" || !u.text) continue;
    if (!isUserTurn(u.id)) continue;
    if (!(u.updatedMs > floor)) continue;
    // A future-dated row (clock skew) is not evidence of anything the owner has said yet.
    if (u.updatedMs > nowMs + 60_000) continue;
    if (normalizeQuote(u.text).includes(needle)) {
      return { ok: true, turnId: u.id, matchedMs: u.updatedMs };
    }
  }
  return { ok: false, reason: "not-found" };
}

// ---- (B) re-grading bound ------------------------------------------------------------------------

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
