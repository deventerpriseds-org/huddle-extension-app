// WHAT:       Pure core of MEETING-MINUTES TRIAGE: split a Fireflies `action_items` text into one row per item,
//             the triage choices (Mine / For someone / Skip) and the states they map to, the typed-name cleaner,
//             the one-ping-per-meeting turn id and directive, the triage store seam, and the grouping that turns
//             stored rows into the report's "Meeting action items for you" list.
// WHY:        Owner 2026-11-14: "a ping when I receive meeting minutes with a drop list ... pick it, type who the
//             action items are for or skip it. Then and only then can they go in the meeting action item queue."
//             AC docs/qc-evidence/AC-correspondence-redesign.md R5 (AC-R5.2, 5.5-5.17). Splitting follows probe
//             P-4 (docs/qc-evidence/PROBES-correspondence-redesign.md): action_items is ONE string per meeting,
//             every line a bullet, 5-36 lines, no headings, no owner structure, a trailing (mm:ss) stamp on some.
// SUPERSEDES: the automatic transcript -> proposals text path (transcriptProposalText fed to extraction).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/meeting-triage.test.ts; scripts/task-proposals-sql.test.ts section T;
//             docs/qc-evidence/IMPL-meeting-triage.md.
//
// THIS REPO IS PUBLIC: no names, ids or content here. Dependency-light (no pg, no fetch).
import { stableHash } from "../correspondence/source-item";
import {
  PROPOSALS_AGENT,
  TASK_MAX,
  canonicalSpan,
  proposalChecklistRow,
  proposalId,
  sanitizeTitle,
  titleKey,
  type NewProposal,
  type ProposalRow,
  type ProposalState,
} from "./proposals";

/** A runaway minutes text cannot flood the checklist (P-4 measured at most 36 lines). */
export const MAX_TRIAGE_PER_MEETING = 50;
/** AC-R5.16: a typed name is capped at this many characters. */
export const TRIAGE_NAME_MAX = 80;

// ── Splitting (AC-R5.2, probe P-4) ──────────────────────────────────────────────────────────────────

/** A leading bullet: - * • · – — or a number with . or ) ("1." / "2)"). */
const BULLET = /^\s*(?:[-*•·–—]+|\d{1,3}[.)])\s+/u;
/** A trailing timestamp "(mm:ss)" or "(h:mm:ss)", possibly several ("(01:02) (03:04)"). */
const STAMP = /\s*\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)\s*$/;
/** A line that is only a heading (not seen by P-4, kept defensive): "**Name**", "## Name", or "Name:" alone. */
const HEADING = /^\s*(?:\*\*[^*]+\*\*:?|#{1,6}\s+.+|[^.!?]{1,60}:)\s*$/u;

export interface SplitResult {
  items: string[];
  dropped: { heading: number; duplicate: number; overCap: number };
}

/** Pure: Fireflies `action_items` (a string, or a list of strings) -> one item per line, bullet and trailing
 *  stamp stripped, invisible / look-alike characters folded, whitespace collapsed, each capped at TASK_MAX.
 *  Blank lines are skipped silently; a heading-only line, a duplicate (same title key) and anything past the
 *  cap are dropped and counted. Never guesses an owner (P-4: the text has none). */
export function splitActionItems(raw: unknown): SplitResult {
  const out: SplitResult = { items: [], dropped: { heading: 0, duplicate: 0, overCap: 0 } };
  const lines: string[] =
    typeof raw === "string" ? raw.split(/\r?\n|\r/) : Array.isArray(raw) ? raw.flatMap((x) => (typeof x === "string" ? x.split(/\r?\n|\r/) : [])) : [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (HEADING.test(line) && !BULLET.test(line)) {
      out.dropped.heading++;
      continue;
    }
    let t = canonicalSpan(sanitizeTitle(line)).replace(BULLET, "");
    while (STAMP.test(t)) t = t.replace(STAMP, "");
    t = t.trim();
    if (!t) continue;
    if (t.length > TASK_MAX) t = `${t.slice(0, TASK_MAX - 1).replace(/\s+\S*$/, "")}…`;
    const key = titleKey(t);
    if (!key || seen.has(key)) {
      out.dropped.duplicate++;
      continue;
    }
    if (out.items.length >= MAX_TRIAGE_PER_MEETING) {
      out.dropped.overCap++;
      continue;
    }
    seen.add(key);
    out.items.push(t);
  }
  return out;
}

/** Pure: the action-items text of a Fireflies summary (the ONLY part triage reads; never the overview). */
export function actionItemsOf(summary: { action_items?: unknown } | null | undefined): unknown {
  return summary?.action_items ?? null;
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────

export interface TriageMeeting {
  meetingId: string;
  title: string | null;
  meetingAt: string | null;
}

/** Pure: the store rows for a meeting's items. Same `prop-` id namespace and dedup key as every proposal; the
 *  evidence IS the action-item line (verbatim), and no assignee (P-4: the owner cannot be inferred). */
export function triageRowsFor(owner: string, m: TriageMeeting, items: string[]): NewProposal[] {
  return items.map((title) => {
    const normTitle = titleKey(title);
    const ref = { source: "transcript" as const, sourceItemId: m.meetingId, at: m.meetingAt, context: m.title ? m.title.slice(0, 160) : null };
    return { id: proposalId(owner, ref, normTitle), owner, title, normTitle, evidence: title, assignee: null, dueText: null, dueDate: null, ref };
  });
}

// ── Choices ─────────────────────────────────────────────────────────────────────────────────────────

export type TriageChoice = "mine" | "someone" | "skip";
export const TRIAGE_CHOICES: readonly TriageChoice[] = ["mine", "someone", "skip"];
/** Mine -> a normal proposal (AC-R5.9); For someone -> delegated, text only (AC-R5.10); Skip -> dismissed, kept as
 *  dedup memory so it never comes back for that meeting (AC-R5.11). */
export const TRIAGE_TARGET: Record<TriageChoice, Extract<ProposalState, "proposed" | "delegated" | "dismissed">> = {
  mine: "proposed",
  someone: "delegated",
  skip: "dismissed",
};

/** Pure (AC-R5.16): the typed name -> trimmed, invisible / control characters removed, whitespace collapsed,
 *  capped at TRIAGE_NAME_MAX characters. Empty -> null (nothing is saved). Stored and shown as plain text. */
export function cleanTriageName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = canonicalSpan(sanitizeTitle(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  if (!s) return null;
  const capped = Array.from(s).slice(0, TRIAGE_NAME_MAX).join("").trim();
  return capped || null;
}

// ── The store seam (implemented by proposals-store.server.ts; an in-memory twin in the tests) ────────

export interface TriageOutcome {
  /** True only for the ONE caller whose compare-and-set on `untriaged` won (AC-R5.17). */
  applied: boolean;
  /** The triage row as it is now (null: not this owner's, or no such row). */
  row: ProposalRow | null;
  /** Mine on a to-do that is ALREADY an active proposal: the meeting's ref moved to that proposal (one
   *  proposal per to-do, OQ-9), and this is it. */
  mergedInto?: ProposalRow | null;
}

export interface TriageStore {
  /** Insert `untriaged` rows for items not seen before for this meeting (the refs table is the memory: a
   *  skipped, delegated or merged item is never re-created). Returns the ids created and the ids already there. */
  addTriageRows(rows: NewProposal[]): Promise<{ created: string[]; existing: string[] }>;
  /** Compare-and-set `untriaged` -> target. `assignee` only with `delegated`. */
  triage(owners: string[], id: string, target: "proposed" | "delegated" | "dismissed", assignee: string | null): Promise<TriageOutcome>;
  getMany(owners: string[], ids: string[]): Promise<ProposalRow[]>;
  /** Every row reached through a meeting ref (any state), with that meeting's id. */
  listMeetingQueue(owners: string[]): Promise<Array<ProposalRow & { meetingId: string }>>;
  /** Untriaged rows, oldest first (the on-request checklist shows them under the proposals). */
  listUntriaged(owners: string[]): Promise<ProposalRow[]>;
}

// ── The ping (one per meeting, AC-R5.5 / R5.6) ──────────────────────────────────────────────────────

/** ONE durable turn per (owner, meeting): enqueueTurn's ON CONFLICT DO NOTHING makes every later attempt
 *  (retry, re-sent or updated minutes) send nothing (AC-R5.6, OQ-9). */
export function meetingTriageTurnId(owner: string, meetingId: string): string {
  return `meeting-triage-${stableHash([owner.trim().toLowerCase(), meetingId])}`;
}

export const MEETING_TRIAGE_TITLE = "Meeting action items";

/** The directive Iris answers. It carries no meeting content (the title and items ride in the checklist). */
export function meetingTriageDirective(n: number): string {
  return (
    `[Internal: meeting action items] A meeting's minutes listed ${n} action item${n === 1 ? "" : "s"}, shown to the user ` +
    "as a checklist under your message. Write ONE short line asking them to mark each one Mine, For someone (they " +
    "type the name) or Skip. Do NOT list or repeat the items, do not guess who they belong to, and do not create any task."
  );
}

export function meetingTriageChecklist(rows: ProposalRow[], meetingTitle: string | null) {
  const t = meetingTitle ? canonicalSpan(meetingTitle).slice(0, 80) : "";
  return { title: t ? `${MEETING_TRIAGE_TITLE}: ${t}` : MEETING_TRIAGE_TITLE, rows: rows.map(proposalChecklistRow) };
}

export function meetingTriagePayload(owner: string, n: number, checklist: ReturnType<typeof meetingTriageChecklist>, tz: string) {
  return {
    text: meetingTriageDirective(n),
    huddleId: `dm-${PROPOSALS_AGENT}`,
    scope: "one-to-one",
    members: [PROPOSALS_AGENT],
    targetAgentId: PROPOSALS_AGENT,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    // journey disabled: this turn presents items to triage; it must never write the board.
    agents: { [PROPOSALS_AGENT]: { backend: "openai", journey: { enabled: false } } },
    timeZone: tz,
    caller: { entra_email: owner },
    notify: "push",
    internal: true,
    checklist,
  };
}

// ── The report's third list (exposed for "Meeting action items for you") ─────────────────────────────

export interface MeetingQueueItem {
  id: string;
  title: string;
  state: ProposalState;
  /** The typed name, For someone rows only. Text only: never resolved to a person. */
  assignee: string | null;
}

export interface MeetingQueueReport {
  /** Newest meeting first; only meetings with at least one Mine or For someone item. */
  meetings: Array<{ meetingId: string; title: string | null; at: string | null; mine: MeetingQueueItem[]; forSomeone: MeetingQueueItem[] }>;
  counts: { mine: number; forSomeone: number; untriaged: number; skipped: number };
}

/** States that mean "the owner said Mine" (an approved / done one is still his, now on the board). */
const MINE_STATES: readonly ProposalState[] = ["proposed", "approved", "completed"];

/** Pure: stored rows (with their meeting id) -> the report shape. Untriaged and skipped are counts only; For
 *  someone rows are listed per meeting but are NOT "for you" (AC-R5.10, AC-R7.4: the report shows Mine). */
export function groupMeetingQueue(rows: Array<ProposalRow & { meetingId: string }>): MeetingQueueReport {
  const counts = { mine: 0, forSomeone: 0, untriaged: 0, skipped: 0 };
  const by = new Map<string, MeetingQueueReport["meetings"][number]>();
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.meetingId}\u001f${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.state === "untriaged") {
      counts.untriaged++;
      continue;
    }
    if (r.state === "dismissed") {
      counts.skipped++;
      continue;
    }
    const mine = MINE_STATES.includes(r.state);
    if (!mine && r.state !== "delegated") continue;
    const src = r.sources.find((s) => s.source === "transcript" && s.sourceItemId === r.meetingId);
    const g = by.get(r.meetingId) ?? { meetingId: r.meetingId, title: src?.context ?? null, at: src?.at ?? null, mine: [], forSomeone: [] };
    by.set(r.meetingId, g);
    const item = { id: r.id, title: r.title, state: r.state, assignee: r.state === "delegated" ? r.assignee : null };
    if (mine) {
      g.mine.push(item);
      counts.mine++;
    } else {
      g.forSomeone.push(item);
      counts.forSomeone++;
    }
  }
  const meetings = [...by.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.meetingId.localeCompare(b.meetingId));
  return { meetings, counts };
}
