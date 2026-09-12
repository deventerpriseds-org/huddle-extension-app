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
//             "what stops an AGENT calling it to unblock itself?" — is what this file answers);
//             .claude/BUILD-override-quote-hardening.md (the 2026-09-12 rewrite below).
//
// HARDENED 2026-09-12 after an independent verifier REFUTED the first version by executing three
// attacks against the real function, all returning ok:true (.claude/VERIFY-override-gate-1.md,
// CLAIM 4). The diagnosis, which drives every filter below: the check proved PROVENANCE ("these
// characters were really typed by the owner") and was read as AUTHORISATION ("these words mean
// proceed, on THIS task"). A length floor over a substring match cannot bridge those, because the
// MODEL chooses which characters to submit. What closes it is judging the owner's whole CLAUSE
// rather than the model's span, requiring it to POSTDATE the escalation, and BINDING it to the task.
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
import { isAuthorisation } from "./green-light";

/** One candidate utterance, projected from `chat.pending_turns`. */
export interface UserUtterance {
  /** `chat.pending_turns.id` — the shape is what proves who was talking (see isUserTurn). */
  id: string;
  /** `payload.text`. For an AGENT-INITIATED turn this is an internal directive, never the user. */
  text: string;
  /** `updated_at` in epoch ms. */
  updatedMs: number;
  /** `chat.pending_turns.huddle_id` — `dm-<agentId>` for a 1:1, `all-members`/`daily` for a group.
   *  Absent/null is treated as "no channel evidence", never as a match. */
  huddleId?: string | null;
}

/**
 * What the authorisation has to be ABOUT. Every field is server-derived: the task row and its
 * engagement state, never anything the model passed in. A caller that cannot supply this cannot use
 * the quote path at all (see the runtime check at the top of verifyOwnerQuote).
 */
export interface OverrideBinding {
  /** The task the override would apply to — the SAME id the write uses, not one the model re-states. */
  taskId: string;
  /** `tasks.journey_tasks.title`. */
  taskTitle: string;
  /** `tasks.journey_tasks.assigned_agent`, or null when the task has no assignee yet. */
  assignedAgent: string | null;
  /**
   * Epoch ms at which this task's approach gate became `escalated`
   * (`task_engagement_state.approach_escalated_at`, falling back to the row's `updated_at`).
   */
  escalatedAtMs: number;
  /**
   * True only when `assignedAgent` has EXACTLY ONE escalated task — this one. Channel binding (an
   * authorisation typed in that agent's DM) is only unambiguous then; with two escalated tasks in
   * the same DM, "go ahead" does not say which. Any doubt, including a failed count, is `false`.
   */
  assigneeBindingUnambiguous: boolean;
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

export type QuoteRejection =
  | "too-short"
  | "not-found"
  | "predates-escalation"
  | "not-consent"
  | "not-this-task";

export type QuoteVerdict =
  | { ok: true; turnId: string; matchedMs: number }
  | { ok: false; reason: QuoteRejection };

/** Sentence/clause terminators kept after typography normalisation. */
const CLAUSE_TERMINATORS = ".!?;";

/**
 * The FULL clause the match falls inside — the fix for the attack that broke this guard.
 *
 * The model chooses the needle, so letting the needle BE the thing that gets judged let it cut a
 * sentence down to the half that reads like consent: the owner typed "Do NOT proceed with that
 * approach, override it later once we know more, not now" and the model submitted only the span
 * after "NOT" (.claude/VERIFY-override-gate-1.md CLAIM 4b, attack C — it returned ok:true).
 *
 * So the span is EXPANDED, never trusted: backwards to the previous terminator, forwards to the
 * next one PAST the end of the match (so a trailing "?" survives to be seen as a question). The
 * caller can only choose which clause is judged; it cannot shrink one.
 */
export function clauseAround(normalized: string, matchStart: number, matchLen: number): string {
  let start = 0;
  for (let i = matchStart - 1; i >= 0; i--) {
    if (CLAUSE_TERMINATORS.includes(normalized[i])) {
      start = i + 1;
      break;
    }
  }
  let end = normalized.length;
  for (let i = matchStart + matchLen; i < normalized.length; i++) {
    if (CLAUSE_TERMINATORS.includes(normalized[i])) {
      end = i + 1;
      break;
    }
  }
  return normalized.slice(start, end).trim();
}

/** Words too common to make a title phrase distinctive on their own. */
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "of", "to", "in", "on", "with", "my", "our", "your",
  "this", "that", "it", "is", "be", "by", "from", "at", "as", "up", "out",
]);

/** A title phrase has to be long enough that quoting it is a deliberate reference, not a coincidence. */
export const TITLE_PHRASE_MIN_CHARS = 10;
export const TITLE_PHRASE_MIN_WORDS = 2;

/**
 * Does this already-normalised utterance name the task, by quoting a distinctive contiguous phrase
 * of its title? EXACT substring only — no similarity score, no stemming (the repo's own rule: fuzzy
 * matching ranks, it never authorises). Stopword-only runs do not count.
 */
export function titlePhraseIn(normalizedText: string, title: string): boolean {
  const words = normalizeQuote(title ?? "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(" ")
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + TITLE_PHRASE_MIN_WORDS; j <= words.length; j++) {
      const run = words.slice(i, j);
      if (run.every((w) => TITLE_STOPWORDS.has(w))) continue;
      const phrase = run.join(" ");
      if (phrase.length < TITLE_PHRASE_MIN_CHARS) continue;
      if (normalizedText.includes(phrase)) return true;
    }
  }
  return false;
}

/**
 * Is this utterance ABOUT the task being overridden? One authorisation must not be replayable onto
 * every other escalated task, which is exactly what the verifier confirmed was possible
 * (.claude/VERIFY-override-gate-1.md CLAIM 4d) — `verifyOwnerQuote` was never given a task at all.
 *
 * Three independent bindings, strongest first. The dispatch sites do not pass the CURRENT huddle
 * (and are owned by another lane this session), so channel evidence comes from the MATCHED TURN's
 * own `huddle_id`, which is server-written and not model-supplied either way.
 */
export function utteranceBindsToTask(u: UserUtterance, binding: OverrideBinding): boolean {
  const text = normalizeQuote(u.text ?? "");
  if (!text) return false;
  const id = normalizeQuote(binding.taskId ?? "");
  if (id.length >= 8 && text.includes(id)) return true;
  if (titlePhraseIn(text, binding.taskTitle ?? "")) return true;
  const agent = normalizeQuote(binding.assignedAgent ?? "");
  if (agent && binding.assigneeBindingUnambiguous === true) {
    if (normalizeQuote(u.huddleId ?? "") === `dm-${agent}`) return true;
  }
  return false;
}

/**
 * THE GUARD. Find a genuine user utterance that AUTHORISES overriding THIS task's approach gate.
 *
 * The previous version proved PROVENANCE — the characters really were typed by the owner, recently —
 * and treated that as AUTHORISATION. An independent verifier disproved that by calling this function
 * with three real attacks, all of which returned ok:true: an unrelated complaint the owner had typed,
 * an agent proposal the owner had pasted back, and a fragment of a sentence in which the owner
 * explicitly said NOT to proceed. A longer quote floor cannot close that gap, because the model
 * chooses which characters to submit. Five filters now, each load-bearing:
 *
 *  1. `isUserTurn(id)` — an agent-initiated turn (autowork confirm-intent, a groom pass, an owner
 *     follow-up) stores its INTERNAL DIRECTIVE in the same `payload.text` field. Without this filter
 *     an agent could quote back a directive it caused to be written and call it the owner's words.
 *  2. the age window — an authorisation is about a moment, not a standing grant.
 *  3. contiguous substring of the normalised text — the owner's sentence, verbatim, allowing the
 *     model to have retyped its punctuation.
 *  4. IT POSTDATES THE ESCALATION. Words typed before the gate ever escalated cannot be consenting
 *     to an override of it, whatever they say.
 *  5. THE WHOLE CLAUSE READS AS CONSENT, and the clause is BOUND TO THIS TASK. `isAuthorisation`
 *     (green-light.ts, the module that already owns "did the user say go") judges the expanded
 *     clause, not the model's span.
 *
 * Returns the matching turn id so the caller can RECORD which utterance authorised the override; a
 * marker with no provenance is not an audit trail.
 */
export function verifyOwnerQuote(
  rawQuote: string,
  utterances: UserUtterance[],
  nowMs: number,
  binding: OverrideBinding,
): QuoteVerdict {
  const needle = normalizeQuote(rawQuote ?? "");
  if (!quoteIsSubstantial(needle)) return { ok: false, reason: "too-short" };
  // FAIL CLOSED on a caller that supplies no task context: without it there is nothing to bind an
  // authorisation to, and "no binding" must never read as "binds to anything".
  if (!binding || typeof binding !== "object") return { ok: false, reason: "not-this-task" };
  const escalatedAtMs = Number(binding.escalatedAtMs);
  if (!Number.isFinite(escalatedAtMs)) return { ok: false, reason: "predates-escalation" };

  const recencyFloor = nowMs - QUOTE_MAX_AGE_MS;
  /** The first near-miss, so the caller can say WHICH rule refused rather than a generic "not found". */
  let firstRejection: QuoteRejection | null = null;

  for (const u of utterances) {
    if (!u || typeof u.text !== "string" || !u.text) continue;
    if (!isUserTurn(u.id)) continue;
    if (!(u.updatedMs > recencyFloor)) continue;
    // A future-dated row (clock skew) is not evidence of anything the owner has said yet.
    if (u.updatedMs > nowMs + 60_000) continue;
    const text = normalizeQuote(u.text);
    const at = text.indexOf(needle);
    if (at < 0) continue;

    if (!(u.updatedMs >= escalatedAtMs)) {
      firstRejection ??= "predates-escalation";
      continue;
    }
    if (!isAuthorisation(clauseAround(text, at, needle.length))) {
      firstRejection ??= "not-consent";
      continue;
    }
    if (!utteranceBindsToTask(u, binding)) {
      firstRejection ??= "not-this-task";
      continue;
    }
    return { ok: true, turnId: u.id, matchedMs: u.updatedMs };
  }
  return { ok: false, reason: firstRejection ?? "not-found" };
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
