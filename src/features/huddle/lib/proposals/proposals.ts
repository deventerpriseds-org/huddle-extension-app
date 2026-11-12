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
export const EVIDENCE_MIN = 8;
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
  | "task_not_grounded"
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

const STOP = new Set(
  "the and for with that this from your you our are was were have has had will would could should please can just into about them they then than there their what when where which while also some more most very need needs".split(" "),
);
/** Content words (>= 4 letters, not a stopword), lower-cased, reduced to a 5-letter stem. */
export function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

const PRONOUN = /^(i|me|my|myself|you|your|yourself|we|us|our|ourselves|someone|somebody|anyone|everyone|team|the team|all)$/i;

/** Pure: keep an assignee only when the evidence names that person (AC-5.20). */
export function groundedAssignee(raw: unknown, evidence: string): string | null {
  if (typeof raw !== "string") return null;
  const a = canonicalSpan(raw);
  if (!a || a.length > 80 || PRONOUN.test(a)) return null;
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(canonicalSpan(evidence)) ? a : null;
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
  const haystack = canonicalSpan(sourceText);
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      no("item_not_object");
      continue;
    }
    const o = t as Record<string, unknown>;
    const title = typeof o.task === "string" ? canonicalSpan(o.task) : "";
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
    if (evidence.length < EVIDENCE_MIN) {
      no("evidence_too_short");
      continue;
    }
    if (evidence.length > EVIDENCE_MAX) {
      no("evidence_too_long");
      continue;
    }
    // Verbatim: a paraphrase, a translation or an invented quote is not a substring of the source.
    if (!haystack.includes(evidence)) {
      no("evidence_not_in_source");
      continue;
    }
    // A real quote attached to an invented task ("Thanks, see you tomorrow" -> "Book flights") shares no
    // content word with it.
    const ev = contentStems(evidence);
    if (![...contentStems(title)].some((w) => ev.has(w))) {
      no("task_not_grounded");
      continue;
    }
    const normTitle = normalizeTaskTitle(title);
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
    const dueText = dueRaw && evidence.toLowerCase().includes(dueRaw.toLowerCase()) ? dueRaw : null;
    accepted.push({
      title,
      normTitle,
      evidence,
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
export function resolveDueDate(dueText: string, atIso: string | null, tz: string): string | null {
  const atMs = atIso ? Date.parse(atIso) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const base = localYmd(atMs, tz);
  const s = dueText.toLowerCase();
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) return Number.isNaN(ymdToUtc(iso[0])) ? null : iso[0];
  if (/\b(today|tonight|eod|end of (the )?day|this evening|this afternoon)\b/.test(s)) return base;
  if (/\btomorrow\b/.test(s)) return addDays(base, 1);
  const md = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  if (md) {
    const month = MONTHS.indexOf(md[1]) + 1;
    const day = +md[2];
    if (day < 1 || day > 31) return null;
    let year = +base.slice(0, 4);
    const pad = (n: number) => String(n).padStart(2, "0");
    let ymd = `${year}-${pad(month)}-${pad(day)}`;
    if (utcToYmd(ymdToUtc(ymd)) !== ymd) return null; // Feb 30
    if (ymd < base) ymd = `${++year}-${pad(month)}-${pad(day)}`;
    return ymd;
  }
  const wd = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`).exec(s);
  if (wd) {
    // "next Friday" means this coming Friday to some people and the one after to others: ambiguous, so
    // no date. Same for "next week Friday".
    if (/\bnext\b/.test(s)) return null;
    const target = WEEKDAYS.indexOf(wd[1]);
    const today = new Date(ymdToUtc(base)).getUTCDay();
    return addDays(base, (target - today + 7) % 7);
  }
  return null;
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

export interface ProposalStore {
  upsert(p: NewProposal): Promise<UpsertOutcome>;
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
