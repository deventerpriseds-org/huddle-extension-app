// WHAT:       Pure core of TASK PROPOSALS: to-dos stated in the owner's email / Teams / meeting transcripts,
//             shown as a second row KIND inside the EXISTING chat checklist (build_checklist / ChecklistCard).
//             Holds the source-text builder, the extraction prompt + strict JSON schema, the Tier 1 VALIDATOR
//             that decides which model output may become a stored claim, due-date resolution, dedup keys,
//             proposal ids, checklist-row mapping, the reply-assembly row sanitizer, and delivery timing.
// WHY:        Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) + AC
//             docs/ac/AC-correspondence-checklist.md section 5. Model output -> stored claim is accusation
//             grade, so the validator, not the prompt, is the guard: a proposal is stored only when its
//             evidence is a verbatim span of the source's NEW text and its task shares words with that span;
//             an owner/due date is kept only when the span itself states it (AC-5.19, AC-5.20).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/task-proposals.test.ts (spelling table S-P*); docs/qc-evidence/IMPL-task-proposals.md.
//
// THIS REPO IS PUBLIC: no addresses, ids or names here. Dependency-light (no pg, no fetch) so the client
// bundle can import the row types and the offline suite can run everything.

import { newTextOnly, screenMessage } from "../email/inbound-email";
import { normalizeTaskTitle } from "../tasks/scoring";
import { stableHash, type CorrespondenceSource, type SourceItem } from "../correspondence/source-item";

export type ProposalState = "proposed" | "approved" | "completed" | "dismissed";
export const PROPOSAL_STATES: readonly ProposalState[] = ["proposed", "approved", "completed", "dismissed"];
/** Decided states leave the active queue but stay for audit and dedup (AC-5.5). */
export const DECIDED_STATES: readonly ProposalState[] = ["approved", "completed", "dismissed"];

/** Proposal ids live in their own namespace: a journey task id is a bare uuid, so `prop-` can never
 *  collide with one in `checklistState` (AC-5.2). */
export const PROPOSAL_ID_PREFIX = "prop-";
export const isProposalId = (id: string) => typeof id === "string" && id.startsWith(PROPOSAL_ID_PREFIX);

/** The agent whose 1:1 carries proposals (owner decision OQ-7), and whose meta-task guard Approve runs. */
export const PROPOSALS_AGENT = "iris-chase" as const;
export const PROPOSALS_HUDDLE = `dm-${PROPOSALS_AGENT}`;

export const TASK_MAX = 200;
/** Red-team F5: a pleasantry fragment ("the deck") must not ground a task. Evidence needs BOTH this many
 *  characters and EVIDENCE_MIN_WORDS words. */
export const EVIDENCE_MIN = 15;
export const EVIDENCE_MIN_WORDS = 4;
export const EVIDENCE_MAX = 400;
/** Bounded per source item: a runaway extraction cannot flood the checklist. */
export const MAX_PER_SOURCE = 8;
const SOURCE_TEXT_MAX = 6000;

// ── Sources ────────────────────────────────────────────────────────────────────────────────────────

/** One source reference a proposal keeps (AC-5.19): kind, provider id, the item's own time. */
export interface ProposalSourceRef {
  source: CorrespondenceSource;
  sourceItemId: string;
  at: string | null;
  /** Subject / chat name / meeting title, for the owner's own display. Never logged. */
  context?: string | null;
}

/** What extraction reads: the NEW text of one source item (never quoted history). */
export interface ProposalSource extends ProposalSourceRef {
  text: string;
}

export type SourceSkip = "self" | "automated-sender" | "bulk-header" | "other-folder" | "app-sender" | "own-message" | "no-text" | "no-payload";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * Pure: a ledger SourceItem -> the text extraction may read, or a skip reason. Email reuses the inbox
 * watch's screen unchanged in "people" mode (self, bulk headers, automated senders and Outlook's Other are
 * never proposal sources; "no ask" is NOT a skip -- "I'll send the deck Friday" states a to-do without a
 * question). Only the sender's NEW text is read (newTextOnly drops quoted history), so a to-do quoted from
 * an older message is never re-proposed from a reply (AC S-13). The owner's own Teams messages and app /
 * bot senders are not sources (default, IMPL log).
 */
export function proposalSourceFromItem(item: SourceItem, mailbox: string): ProposalSource | { skip: SourceSkip } {
  if (item.source === "email") {
    const m = item.email;
    if (!m) return { skip: "no-payload" };
    const v = screenMessage(m, "people", mailbox);
    if (!v.keep) return { skip: v.reason as SourceSkip };
    const subject = String(m.subject ?? "").trim();
    // A reply's subject is history too (the asksSomething rule), so only an original subject is text.
    const ownSubject = /^\s*(re|fw|fwd)\s*:/i.test(subject) ? "" : subject;
    const body = newTextOnly(String(m.bodyText ?? m.bodyPreview ?? ""));
    const text = clip([ownSubject, body].filter((s) => s.trim()).join("\n"), SOURCE_TEXT_MAX).trim();
    if (!text) return { skip: "no-text" };
    return { source: "email", sourceItemId: item.sourceItemId, at: item.at, context: subject.slice(0, 160) || null, text };
  }
  if (item.source === "teams") {
    const t = item.teams;
    if (!t) return { skip: "no-payload" };
    if (t.senderIsApp) return { skip: "app-sender" };
    if (t.fromOwner === true) return { skip: "own-message" };
    const text = clip(newTextOnly(t.text ?? ""), SOURCE_TEXT_MAX).trim();
    if (!text) return { skip: "no-text" };
    return { source: "teams", sourceItemId: item.sourceItemId, at: item.at, context: (t.chatName ?? "").slice(0, 160) || null, text };
  }
  return { skip: "no-payload" };
}

/** Pure: the part of a Fireflies transcript proposals read -- its action items and overview (the summary
 *  Fireflies already produced), never the whole spoken transcript. Values are strings or string lists. */
export function transcriptProposalText(summary: { action_items?: unknown; overview?: unknown; short_summary?: unknown } | null | undefined): string {
  const block = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : "")).filter(Boolean).join("\n").trim();
    return "";
  };
  const parts = [block(summary?.action_items), block(summary?.overview ?? summary?.short_summary)].filter(Boolean);
  return clip(parts.join("\n\n"), SOURCE_TEXT_MAX).trim();
}

// ── Extraction (model) ─────────────────────────────────────────────────────────────────────────────

export const EXTRACTION_SCHEMA_NAME = "task_proposals";
/** Strict JSON schema for the model's answer (OpenAI Responses `text.format`, strict: every key required). */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "evidence", "assignee", "due_text"],
        properties: {
          task: { type: "string", description: "The to-do as a short imperative, in the source's own words." },
          evidence: { type: "string", description: "The EXACT sentence or phrase from the source that states the to-do, copied character for character." },
          assignee: { type: ["string", "null"], description: "The person the evidence NAMES as doing it, else null." },
          due_text: { type: ["string", "null"], description: "The date words the evidence itself contains (e.g. 'by Friday'), else null." },
        },
      },
    },
  },
} as const;

export const EXTRACTION_INSTRUCTIONS =
  "You find to-dos in ONE message or meeting summary written to the user. List a to-do ONLY when the text " +
  "STATES it or CLEARLY ASSIGNS it (a request to the user, a commitment, an action item). Never infer, suggest " +
  "or invent work. Pleasantries, FYIs, newsletters, questions already answered and anything quoted from older " +
  "messages are NOT to-dos. For each to-do return: task (a short imperative in the text's own words), evidence " +
  "(the exact span from the text, copied verbatim, that states it), assignee (only a person the evidence names, " +
  "otherwise null), due_text (only date words that appear in the evidence, otherwise null). If there are none, " +
  'return {"tasks": []}.';

export function extractionInput(src: ProposalSource): string {
  return `SOURCE (${src.source}):\n${src.text}`;
}

// ── Validation (Tier 1: the guard between model output and a stored claim) ─────────────────────────

export type RejectReason =
  | "not_object"
  | "tasks_not_array"
  | "item_not_object"
  | "task_missing"
  | "task_too_long"
  | "evidence_missing"
  | "evidence_too_short"
  | "evidence_too_long"
  | "evidence_not_in_source"
  | "evidence_negated"
  | "task_not_grounded"
  | "task_number_not_grounded"
  | "duplicate_in_batch"
  | "over_cap";

export interface ValidCandidate {
  title: string;
  normTitle: string;
  evidence: string;
  assignee: string | null;
  dueText: string | null;
  /** YYYY-MM-DD in the owner's zone, only when the evidence's own date words resolve. */
  dueDate: string | null;
}

/** Whitespace collapsed, typographic quotes/dashes straightened -- the ONLY liberties a "verbatim" span gets. */
export function canonicalSpan(s: string): string {
  return String(s ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** canonicalSpan, but newlines are kept as single "\n" (each with no spaces around it), so a "\n" stands
 *  exactly where canonicalSpan would put one space. */
export function canonicalLines(s: string): string {
  return String(s ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

const STOP = new Set(
  ("the and for with that this from your you our are was were have has had will would could should please can just into about " +
    "them they then than there their what when where which while also some more most very need needs any all its his her him " +
    "she get got let but not yet per via who how why may might must shall") .split(" "),
);

/** Red-team F6: a LIGHT suffix strip on a whole word (s / es / ed / ing), never a fixed-length prefix, so
 *  "presentation" and "preserve" stay different words while "sends"/"send" and "reviewing"/"review" match. */
export function lightStem(w: string): string {
  if (/\d/.test(w)) return w;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ied")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const words = (s: string): string[] => String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Content words: >= 3 letters (or any token with a digit, e.g. "q3"), not a stopword, light-stemmed. */
export function contentWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(s)) {
    if (!/\d/.test(w) && (w.length < 3 || STOP.has(w))) continue;
    out.add(lightStem(w));
  }
  return out;
}
/** @deprecated name kept for callers; whole-word light stems now (red-team F6). */
export const contentStems = contentWords;

/** Pure (red-team F4): is the task title grounded in the evidence? Every number / amount / account-like
 *  token of the title must appear in the evidence as a whole token, and a STRICT MAJORITY of the title's
 *  content words must appear (whole word, light stem) -- one shared verb no longer carries an invented
 *  object ("Send $40,000 wire to account 99-1234" on "Please send the invoice ..."). */
export function titleGrounding(title: string, evidence: string): "ok" | "task_not_grounded" | "task_number_not_grounded" {
  const evTokens = new Set(words(evidence));
  for (const w of words(title)) if (/\d/.test(w) && !evTokens.has(w)) return "task_number_not_grounded";
  const ev = contentWords(evidence);
  const tw = [...contentWords(title)];
  if (!tw.length) return "task_not_grounded";
  const hit = tw.filter((w) => ev.has(w)).length;
  return hit * 2 > tw.length ? "ok" : "task_not_grounded";
}

// ── Title normalisation for dedup (red-team F13) ────────────────────────────────────────────────────

/** Zero-width / bidi / format characters (Unicode Cf) and the soft hyphen: invisible, never part of a title. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\p{Cf}]/gu;
/** Cyrillic / Greek letters that render like Latin ones (the practical subset of Unicode confusables). */
const CONFUSABLE: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
  "А": "A", "В": "B", "Е": "E", "Ё": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "Ѕ": "S", "І": "I", "Ј": "J", "Ԁ": "D", "Ԛ": "Q", "Ԝ": "W", "Һ": "H",
  "α": "a", "ο": "o", "ν": "v", "ι": "i", "κ": "k", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");

/** Pure (red-team F13): NFKC (full-width, ligatures), invisible characters removed, and look-alike
 *  Cyrillic/Greek letters folded to Latin INSIDE a word that also has Latin letters (a mixed-script word is
 *  the spoofing signature; an all-Cyrillic word is real text and is left alone). */
export function sanitizeTitle(raw: string): string {
  const s = String(raw ?? "").normalize("NFKC").replace(INVISIBLE, "");
  return s.replace(/[\p{L}\p{M}]+/gu, (w) => (/[A-Za-z]/.test(w) ? w.replace(CONFUSABLE_RE, (c) => CONFUSABLE[c] ?? c) : w));
}

/** THE proposal-side title key: sanitizeTitle then the ONE board normalizer (normalizeTaskTitle, unchanged).
 *  Used for proposal dedup, the "already on the board" check and Approve's duplicate screen, so a title
 *  with a zero-width or homoglyph character cannot slip past any of them. */
export function titleKey(title: string): string {
  return normalizeTaskTitle(sanitizeTitle(title));
}

/** Pure (red-team F14): two proposal keys say the same to-do in different words -- the same content words
 *  (light stems, articles/stopwords ignored) with Jaccard >= 0.6, AND identical number tokens ("Q3" vs "Q4"
 *  are different to-dos). */
export function similarTitleKeys(a: string, b: string): boolean {
  if (a === b) return true;
  const na = words(a).filter((w) => /\d/.test(w)).sort().join(" ");
  const nb = words(b).filter((w) => /\d/.test(w)).sort().join(" ");
  if (na !== nb) return false;
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (A.size + B.size - inter) >= 0.6;
}

// ── Evidence sentence + negation (red-team F7) ──────────────────────────────────────────────────────

/** Pure: the full sentence(s) of `haystackNl` (canonical text, newlines kept) that enclose [start, end).
 *  Boundaries: . ! ? followed by a space, a newline, or the text's ends. */
export function enclosingSentence(haystackNl: string, start: number, end: number): { text: string; start: number } {
  let a = start;
  while (a > 0) {
    const ch = haystackNl[a - 1];
    if (ch === "\n") break;
    if (ch === " " && /[.!?]/.test(haystackNl[a - 2] ?? "")) break;
    a--;
  }
  let b = end;
  while (b < haystackNl.length) {
    const ch = haystackNl[b];
    if (ch === "\n") break;
    if (/[.!?]/.test(ch) && (b + 1 >= haystackNl.length || /\s/.test(haystackNl[b + 1]))) {
      b++;
      break;
    }
    b++;
  }
  return { text: haystackNl.slice(a, b).trim(), start: a };
}

/** Negations that put the action OFF ("do not send", "no need to send"); "don't forget to" and
 *  "don't hesitate to" are affirmative and are removed before the test. */
const NEGATION = /\b(do not|does not|don't|dont|doesn't|did not|didn't|never|no need to|not|shouldn't|should not|must not|mustn't|need not|needn't|won't|will not|cannot|can't|please don't|stop|hold off( on)?|no longer)\b/i;
const NOT_NEGATION = /\b(do not|don't|dont|never|please don't)\s+(forget|hesitate|fail|miss)\b|\bnot only\b|\bif not\b/gi;

/** Pure (red-team F7): does the sentence negate the action before the task's first grounded word?
 *  Looks at the clause that leads into the action (after the last , ; : or "but"). */
export function negatesAction(sentence: string, evidenceOffset: number, evidence: string, title: string): boolean {
  const tw = contentWords(title);
  // Where the action starts inside the evidence: the first evidence word that grounds a title word.
  let actionAt = evidence.length;
  for (const m of evidence.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (tw.has(lightStem(m[0].toLowerCase()))) {
      actionAt = m.index ?? 0;
      break;
    }
  }
  const lead = sentence.slice(0, evidenceOffset) + evidence.slice(0, actionAt);
  const clause = lead.split(/[,;:]|\bbut\b/i).pop() ?? "";
  return NEGATION.test(clause.replace(NOT_NEGATION, " "));
}

const PRONOUN = /^(i|me|my|myself|you|your|yourself|we|us|our|ourselves|someone|somebody|anyone|everyone|team|the team|all)$/i;

const NOT_A_PERSON = new Set(
  ("monday tuesday wednesday thursday friday saturday sunday today tomorrow tonight january february march april may june " +
    "july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec eod asap please thanks " +
    "hi hello hey team everyone all someone anyone").split(" "),
);
const REQUESTER_VERBS = "asked|asks|told|tells|wants|wanted|said|says|mentioned|requested|requests|suggested|emailed|wrote|reminded";
const DOER_VERBS =
  "will|'ll|shall|should|can|could|must|to|needs to|need to|has to|have to|is going to|is to|agreed to|offered to|owns|is on|is handling|is taking|takes|takes care of|handles|is responsible for";

/**
 * Pure: keep an assignee only when the evidence names that person AS THE ONE DOING IT (AC-5.20, red-team
 * F12): a capitalized name (1-3 words, not a weekday/month/greeting) that is the SUBJECT of the action
 * ("Dana will update ...", "Dana to send ..."), the ADDRESSEE of the request ("Dana, can you ...",
 * "@Dana"), or the object of a hand-off ("ask Dana to ...", "assigned to Dana"). "Bob asked me to ..."
 * names Bob as the requester, so no assignee.
 */
export function groundedAssignee(raw: unknown, evidence: string): string | null {
  if (typeof raw !== "string") return null;
  const a = canonicalSpan(sanitizeTitle(raw)).replace(/^@/, "");
  if (!a || a.length > 80 || PRONOUN.test(a)) return null;
  const parts = a.split(" ");
  if (parts.length > 3 || !parts.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w))) return null;
  if (parts.some((w) => NOT_A_PERSON.has(w.toLowerCase().replace(/[.']+$/, "")))) return null;
  const ev = canonicalSpan(evidence);
  const name = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const B = "(?:^|[^\\p{L}\\p{N}@])";
  const E = "(?![\\p{L}\\p{N}])";
  const re = (src: string) => new RegExp(src, "u");
  // The name must be present, case-exact (a capitalized name, not the common word).
  if (!re(`${B}@?${name}${E}`).test(ev)) return null;
  if (re(`${B}${name}\\s+(${REQUESTER_VERBS})\\b`).test(ev)) return null;
  const roles = [
    `(?:^|[.!?]\\s+)(?:hi|hey|hello|ok|so)?,?\\s*${name}\\s*[,:\\-]`, // addressee: "Dana, can you ..."
    `@${name}${E}`, // mention
    `${B}${name}\\s+(?:${DOER_VERBS})\\b`, // subject of the action
    `\\b(?:ask|asking|have|get|tell|remind|let)\\s+${name}\\s+(?:to\\b|know\\b)`, // hand-off
    `\\b(?:assigned to|owner:?|action:?|for)\\s+${name}${E}`,
    `,\\s*${name}\\s*[?.!]?$`, // trailing addressee: "Can you send it, Dana?"
  ];
  return roles.some((r) => re(r).test(ev)) ? a : null;
}

/**
 * THE GUARD (AC-5.19 / 5.20). Raw model JSON + the exact source text -> the candidates that may be stored.
 * Anything not provably grounded in the source is dropped and counted by reason; nothing is repaired.
 */
export function validateCandidates(
  raw: unknown,
  sourceText: string,
  ctx: { atIso: string | null; tz: string },
): { accepted: ValidCandidate[]; rejected: Partial<Record<RejectReason, number>> } {
  const rejected: Partial<Record<RejectReason, number>> = {};
  const no = (r: RejectReason) => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const accepted: ValidCandidate[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    no("not_object");
    return { accepted, rejected };
  }
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    no("tasks_not_array");
    return { accepted, rejected };
  }
  // Same canonical text twice: with newlines kept (sentence boundaries) and flattened (the verbatim test).
  // Every newline replaces exactly one space, so offsets in the two strings are identical.
  const haystackNl = canonicalLines(sourceText);
  const haystack = haystackNl.replace(/\n/g, " ");
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      no("item_not_object");
      continue;
    }
    const o = t as Record<string, unknown>;
    // Red-team F13: invisible / look-alike characters never reach the stored title or its dedup key.
    const title = typeof o.task === "string" ? canonicalSpan(sanitizeTitle(o.task)) : "";
    if (!title) {
      no("task_missing");
      continue;
    }
    if (title.length > TASK_MAX) {
      no("task_too_long");
      continue;
    }
    const evidence = typeof o.evidence === "string" ? canonicalSpan(o.evidence) : "";
    if (!evidence) {
      no("evidence_missing");
      continue;
    }
    if (evidence.length < EVIDENCE_MIN || words(evidence).length < EVIDENCE_MIN_WORDS) {
      no("evidence_too_short");
      continue;
    }
    if (evidence.length > EVIDENCE_MAX) {
      no("evidence_too_long");
      continue;
    }
    // Verbatim: a paraphrase, a translation or an invented quote is not a substring of the source.
    const at = haystack.indexOf(evidence);
    if (at < 0) {
      no("evidence_not_in_source");
      continue;
    }
    // A real quote attached to an invented task ("Thanks, see you tomorrow" -> "Book flights"), or an
    // invented amount/account riding on one shared verb, is not grounded (red-team F4/F6).
    const grounding = titleGrounding(title, evidence);
    if (grounding !== "ok") {
      no(grounding);
      continue;
    }
    // Red-team F7: the owner sees the WHOLE sentence the span came from, and a span cut out of a sentence
    // that negates the action ("Please do NOT send the contract ...") is refused.
    const sentence = enclosingSentence(haystackNl, at, at + evidence.length);
    if (negatesAction(sentence.text, at - sentence.start, evidence, title)) {
      no("evidence_negated");
      continue;
    }
    const shownEvidence = sentence.text.length <= EVIDENCE_MAX ? sentence.text : evidence;
    const normTitle = titleKey(title);
    if (seen.has(normTitle)) {
      no("duplicate_in_batch");
      continue;
    }
    if (accepted.length >= MAX_PER_SOURCE) {
      no("over_cap");
      continue;
    }
    seen.add(normTitle);
    const dueRaw = typeof o.due_text === "string" ? canonicalSpan(o.due_text) : "";
    // Red-team F10: due_text must be ONLY date words, and appear in the evidence.
    const dueText = dueRaw && isDateWords(dueRaw) && evidence.toLowerCase().includes(dueRaw.toLowerCase()) ? dueRaw : null;
    accepted.push({
      title,
      normTitle,
      evidence: shownEvidence,
      assignee: groundedAssignee(o.assignee, evidence),
      dueText,
      dueDate: dueText ? resolveDueDate(dueText, ctx.atIso, ctx.tz) : null,
    });
  }
  return { accepted, rejected };
}

// ── Due dates (only from the evidence's own words) ─────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Red-team F11: a month is a WHOLE word -- the full name, the 3-letter abbreviation (optionally with a
 *  dot) or "sept" -- never a word prefix ("marketing" is not March, "decide" is not December). */
const MONTH_WORD = `(${[...MONTH_NAMES, ...MONTHS, "sept"].join("|")})\\.?`;
const monthIndex = (w: string) => {
  const k = w.toLowerCase().replace(/\.$/, "");
  return k === "sept" ? 9 : MONTHS.indexOf(k.slice(0, 3)) + 1;
};

const DATE_WORDS = new Set(
  [
    ...WEEKDAYS, ...MONTHS, ...MONTH_NAMES, "sept",
    "by", "on", "before", "until", "till", "til", "due", "the", "of", "this", "next", "coming", "end", "eod", "eow", "cob",
    "close", "business", "day", "week", "month", "today", "tonight", "tomorrow", "morning", "afternoon", "evening", "night",
    "noon", "midday", "at", "latest", "no", "later", "than", "asap", "soon", "possible", "as", "within", "in", "a", "an",
    "am", "pm", "st", "nd", "rd", "th", "et", "est", "edt", "pt", "pst", "pdt", "ct", "utc", "gmt",
  ],
);
const DAY_NUM = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
/** A real date term (verifier loop 3, M2): a weekday; a month name next to a day number (either order,
 *  "the"/"of" allowed between); today / tomorrow / tonight; EOD / EOW (or "end of [the] day/week",
 *  "close of business", COB); a numeric date (2026-11-14, 11/14, 11/14/2026); "next"/"this" + a unit. */
const REAL_DATE_TERM = new RegExp(
  [
    `\\b(?:${WEEKDAYS.join("|")})\\b`,
    `\\b${MONTH_WORD}\\s+(?:the\\s+)?${DAY_NUM}\\b`,
    `\\b${DAY_NUM}\\s+(?:of\\s+)?${MONTH_WORD}(?![a-z])`,
    `\\b(?:today|tomorrow|tonight|eod|eow|cob)\\b`,
    `\\bend\\s+of\\s+(?:the\\s+)?(?:day|week|business)\\b|\\bclose\\s+of\\s+business\\b`,
    `\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`,
    `\\b(?:next|this)\\s+(?:day|week|month|${WEEKDAYS.join("|")})\\b`,
  ].join("|"),
  "i",
);
/** Pure (red-team F10): due_text is ONLY date words (weekdays, months, numbers, ordinals, ISO dates and
 *  connective words like "by", "end of day") -- at most 8 words. A whole sentence is not a due text.
 *  Verifier loop 3, M2: it must also hold a REAL date term, so "may" (a verb) or "3" (a quantity) alone is
 *  never kept as a due text. */
export function isDateWords(s: string): boolean {
  const ws = String(s ?? "").toLowerCase().match(/[a-z]+|\d+(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}/g) ?? [];
  if (!ws.length || ws.length > 8) return false;
  return ws.every((w) => /^\d/.test(w) || DATE_WORDS.has(w)) && REAL_DATE_TERM.test(String(s));
}

/** YYYY-MM-DD of an instant in a zone. */
export function localYmd(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const ymdToUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const utcToYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => utcToYmd(ymdToUtc(ymd) + n * 86_400_000);

/**
 * Pure: date words from the evidence -> a calendar date in the owner's zone, relative to the SOURCE's own
 * time (not the processing time). Unrecognised or vague words ("soon", "next week", "ASAP") -> null: a
 * due date is never guessed (AC-5.20).
 */
/** Pure: a real calendar date as YYYY-MM-DD, or null (red-team F3: 2026-02-30 and 2026-13-45 are not
 *  dates; a DATE column would throw on them). */
export function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return utcToYmd(ymdToUtc(ymd)) === ymd ? ymd : null;
}

export function resolveDueDate(dueText: string, atIso: string | null, tz: string): string | null {
  const atMs = atIso ? Date.parse(atIso) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const base = localYmd(atMs, tz);
  const s = dueText.toLowerCase();
  const nextYearIfPast = (m: number, d: number): string | null => {
    const y = +base.slice(0, 4);
    const ymd = validYmd(y, m, d);
    if (!ymd) return null;
    return ymd < base ? validYmd(y + 1, m, d) : ymd;
  };
  // Every date term in the text, with its position. Red-team F11: a term right after a negation
  // ("not today", "no later than" excepted) is dropped, and the FIRST remaining term wins
  // ("by tomorrow, not today" -> tomorrow).
  type Term = { at: number; end: number; ymd: string | null; vague?: boolean };
  const terms: Term[] = [];
  const add = (re: RegExp, f: (m: RegExpExecArray) => string | null, vague = false) => {
    for (const m of s.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      terms.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, ymd: f(m as RegExpExecArray), vague });
    }
  };
  add(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => validYmd(+m[1], +m[2], +m[3]));
  add(/\b(today|tonight|eod|end of (the )?day|this evening|this afternoon)\b/, () => base);
  add(/\btomorrow\b/, () => addDays(base, 1));
  add(new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|am\\b|pm\\b))`), (m) => nextYearIfPast(monthIndex(m[1]), +m[2]));
  add(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?![a-z])`), (m) => nextYearIfPast(monthIndex(m[2]), +m[1]));
  add(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`), (m) => {
    const target = WEEKDAYS.indexOf(m[1]);
    const today = new Date(ymdToUtc(base)).getUTCDay();
    return addDays(base, (target - today + 7) % 7);
  });
  // "next Friday" means this coming Friday to some people and the one after to others: ambiguous, so no
  // date at all when the text says "next" (same for "next week Friday").
  if (/\bnext\b/.test(s)) return null;
  const negated = (t: Term) => /\b(not|never|isn't|n't)\s+(?:by\s+|on\s+|until\s+|before\s+)?$/.test(s.slice(Math.max(0, t.at - 16), t.at));
  const live = terms.filter((t) => !negated(t)).sort((x, y) => x.at - y.at);
  // Overlapping matches ("nov 14" also contains the weekday-free day-month form): the earliest start wins.
  return live.length ? live[0].ymd : null;
}

// ── Identity / dedup ───────────────────────────────────────────────────────────────────────────────

/** Proposal id from its FIRST source ref + normalized text: stable across re-reads, `prop-` namespaced. */
export function proposalId(owner: string, ref: { source: string; sourceItemId: string }, normTitle: string): string {
  return PROPOSAL_ID_PREFIX + stableHash([owner.toLowerCase(), ref.source, ref.sourceItemId, normTitle]);
}

/** A candidate ready for the store. */
export interface NewProposal {
  id: string;
  owner: string;
  title: string;
  normTitle: string;
  evidence: string;
  assignee: string | null;
  dueText: string | null;
  dueDate: string | null;
  ref: ProposalSourceRef;
}

export interface ProposalRow {
  id: string;
  owner: string;
  state: ProposalState;
  title: string;
  originalTitle: string;
  normTitle: string;
  edited: boolean;
  evidence: string;
  assignee: string | null;
  dueText: string | null;
  dueDate: string | null;
  sources: ProposalSourceRef[];
  taskId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Outcome of recording one candidate (AC-5.21 / OQ-9). */
export type UpsertOutcome =
  /** This (source item, to-do) was seen before, in ANY state: nothing changes. */
  | { kind: "seen"; id: string }
  /** The same to-do is already an ACTIVE proposal from another source: this ref was attached to it. */
  | { kind: "attached"; id: string }
  | { kind: "created"; id: string };

/** A stored proposal that may suppress a new candidate (red-team F14/F15). */
export interface PriorProposal {
  id: string;
  normTitle: string;
  state: ProposalState;
  /** The row already references this exact source item. */
  sameItem: boolean;
}

export interface ProposalStore {
  upsert(p: NewProposal): Promise<UpsertOutcome>;
  /** Rows of these owners, ANY state, that already reference this source item, plus DISMISSED rows with
   *  exactly this dedup key from any source. Read before upsert so a reworded re-extraction of the same item
   *  (F14) and a to-do already dismissed elsewhere (F15) are not proposed again. */
  priorRelated(owners: string[], ref: { source: CorrespondenceSource; sourceItemId: string }, normTitle: string): Promise<PriorProposal[]>;
  /** Active (state = proposed) rows of any of these owner emails, oldest first. */
  listActive(owners: string[]): Promise<ProposalRow[]>;
  getMany(owners: string[], ids: string[]): Promise<ProposalRow[]>;
  /** Compare-and-set lease on a proposed row (AC-5.8). `row` is the current row whatever happened. */
  claimApprove(owners: string[], id: string, leaseSeconds: number): Promise<{ claimed: boolean; row: ProposalRow | null }>;
  finishApprove(id: string, taskId: string | null): Promise<ProposalRow | null>;
  releaseApprove(id: string): Promise<void>;
  /** proposed -> completed | dismissed, CAS. */
  decide(owners: string[], id: string, state: "completed" | "dismissed"): Promise<{ applied: boolean; row: ProposalRow | null }>;
  /** Only a `proposed` row can be edited (AC-5.11). */
  edit(owners: string[], id: string, title: string): Promise<{ applied: boolean; row: ProposalRow | null }>;
}

// ── Checklist rows (the EXISTING widget's payload, new row kind) ────────────────────────────────────

/** Per-row proposal detail carried on a `kind:"proposal"` ChecklistRow. Display only; every action re-reads
 *  the server row by id. */
export interface ProposalRowInfo {
  state: ProposalState;
  /** "Email" | "Teams" | "Meeting" (+ "+1" when a second source agreed). */
  sourceLabel: string;
  at: string | null;
  context: string | null;
  evidence: string;
  assignee: string | null;
  dueDate: string | null;
  dueText: string | null;
  /** The journey task created on Approve (AC-5.9). */
  linkedTaskId: string | null;
}

const SOURCE_LABEL: Record<CorrespondenceSource, string> = { email: "Email", teams: "Teams", transcript: "Meeting" };

export function proposalChecklistRow(p: ProposalRow): {
  taskId: string;
  title: string;
  status: string;
  tags: string[];
  kind: "proposal";
  proposal: ProposalRowInfo;
} {
  const first = p.sources[0];
  const extra = p.sources.length > 1 ? ` +${p.sources.length - 1}` : "";
  return {
    taskId: p.id,
    title: p.title,
    status: p.state,
    tags: [],
    kind: "proposal",
    proposal: {
      state: p.state,
      sourceLabel: (first ? SOURCE_LABEL[first.source] : "Source") + extra,
      at: first?.at ?? null,
      context: first?.context ?? null,
      evidence: p.evidence,
      assignee: p.assignee,
      dueDate: p.dueDate,
      dueText: p.dueText,
      linkedTaskId: p.taskId,
    },
  };
}

export const PROPOSALS_TITLE = "Proposed tasks";

/**
 * Pure: sanitize a checklist payload recovered from a tool result or a durable payload, field by field
 * (the reply-assembly's existing rule). A row with no `kind` maps EXACTLY as before (AC-5.1); a proposal
 * row keeps its kind and display detail, and must carry a `prop-` id (AC-5.2).
 */
export function sanitizeChecklistPayload(c: unknown):
  | { title: string; rows: Array<Record<string, unknown> & { taskId: string; title: string; status: string; tags: string[] }>; more?: number }
  | undefined {
  if (!c || typeof c !== "object") return undefined;
  const o = c as { title?: unknown; rows?: unknown; more?: unknown };
  if (typeof o.title !== "string" || !Array.isArray(o.rows) || !o.rows.length) return undefined;
  const rows = o.rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && typeof (row as { taskId?: unknown }).taskId === "string" && typeof (row as { title?: unknown }).title === "string")
    .flatMap((row) => {
      const base = {
        taskId: row.taskId as string,
        title: row.title as string,
        status: typeof row.status === "string" ? row.status : "BACKLOG",
        tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
      };
      if (row.kind !== "proposal") return [base];
      if (!isProposalId(base.taskId)) return [];
      const p = (row.proposal && typeof row.proposal === "object" ? row.proposal : {}) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      const state = PROPOSAL_STATES.includes(p.state as ProposalState) ? (p.state as ProposalState) : "proposed";
      return [
        {
          ...base,
          status: state,
          kind: "proposal",
          proposal: {
            state,
            sourceLabel: s(p.sourceLabel) ?? "Source",
            at: s(p.at),
            context: s(p.context),
            evidence: s(p.evidence) ?? "",
            assignee: s(p.assignee),
            dueDate: s(p.dueDate),
            dueText: s(p.dueText),
            linkedTaskId: s(p.linkedTaskId),
          } satisfies ProposalRowInfo,
        },
      ];
    });
  if (!rows.length) return undefined;
  return { title: o.title, rows, ...(typeof o.more === "number" && o.more > 0 ? { more: o.more } : {}) };
}

// ── Delivery timing (owner decision: after the 6pm pass, weekdays, Iris's 1:1) ──────────────────────

export const DELIVER_AT_DEFAULT = "18:30";
/** After this, a delivery that has not happened waits for tomorrow (no late-night posts). */
const DELIVER_UNTIL = "22:00";
/** How long the delivery waits for still-due extraction work before posting anyway. */
export const DELIVER_GRACE_MIN = 60;

const hhmm = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const weekday = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms));
const addMin = (t: string, n: number) => {
  const m = +t.slice(0, 2) * 60 + +t.slice(3, 5) + n;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Pure: should the evening checklist be posted on this tick? */
export function eveningDeliveryDue(o: { nowMs: number; tz: string; deliverAt?: string; workPending: boolean; activeCount: number }): boolean {
  if (o.activeCount <= 0) return false;
  if (["Sat", "Sun"].includes(weekday(o.nowMs, o.tz))) return false; // the flow runs on weekdays
  const at = /^\d{2}:\d{2}$/.test(o.deliverAt ?? "") ? (o.deliverAt as string) : DELIVER_AT_DEFAULT;
  const now = hhmm(o.nowMs, o.tz);
  if (now < at || now >= DELIVER_UNTIL) return false;
  return !o.workPending || now >= addMin(at, DELIVER_GRACE_MIN);
}

/** ONE durable turn per owner per local day: enqueueTurn's ON CONFLICT makes a re-run send nothing. */
export function eveningDeliveryTurnId(owner: string, nowMs: number, tz: string): string {
  return `task-proposals-${stableHash([owner.toLowerCase()])}-${localYmd(nowMs, tz)}`;
}

export function eveningDeliveryDirective(n: number): string {
  return (
    `[Internal: evening task proposals] ${n} possible to-do${n === 1 ? " was" : "s were"} found in the user's email, ` +
    "Teams chats and meetings and are shown to them as a checklist under your message. Write ONE short line " +
    "telling them they are there for review (approve, edit, mark done or dismiss). Do NOT list or repeat them, " +
    "and do not create any task."
  );
}
