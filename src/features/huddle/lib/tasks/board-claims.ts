// WHAT:       The PURE facts about what an agent actually DID to the board / the work this turn, read off the
//             turn's recorded toolUses (the same records the chat breadcrumbs show). Used by the 1:1 hand-off
//             decision (F1: "the addressed agent already handled it") and by the turn honesty presenter (F6:
//             "never claim a board action that was not performed").
// WHY:        A toolUse with ok=true is NOT proof a write happened (AC-handoff-confirm-flow.md CF-8): a status
//             change deferred to the assignee, a dedup-skipped create, a blocked meta-task and a Huddle-only
//             suggestion are all recorded ok=true. Every consumer must read "performed" from ONE predicate.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-handoff-lane-a.md; scripts/handoff-lane-a.test.ts.
//
// No server imports: huddle.functions.ts calls this inside the synchronous reply assembly, and the offline
// tests import it with bun.

/** The structural board facts a journey board tool call carries (task, status, tags), recorded beside the
 *  toolUse by the dispatcher. Optional: older records and non-board tools have none. */
export type BoardFact = {
  taskId?: string;
  title?: string;
  status?: string;
  tags?: string[];
};

/** The minimal toolUse shape these predicates read (ToolUseEvent satisfies it). */
export type ToolUseLike = {
  agentId: string;
  tool: string;
  summary: string;
  ok: boolean;
  detail?: string;
  board?: BoardFact;
};

/** journey catalog tools that CREATE tasks (mirrors create-task-core RAW_JOURNEY_CREATE_TOOLS). */
const RAW_CREATE_TOOLS = new Set(["quick_create_task", "parse_and_create_tasks", "create_task"]);
/** journey catalog tools that CHANGE an existing task. */
const STATUS_TOOLS = new Set(["update_task", "batch_update_tasks"]);
const DELETE_TOOLS = new Set(["delete_task"]);

/** Summaries the dispatcher writes for a call that did NOT perform a write, although it records ok=true. */
const NOT_PERFORMED_RE =
  /^(?:deferred\b|blocked\b|offered\b|suggested\b|no new tasks created\b)|skipped duplicate|Huddle-only|journey disabled/i;

export function isDeferredStatusChange(u: ToolUseLike): boolean {
  return u.ok && /^deferred\b/i.test(u.summary) && STATUS_TOOLS.has(u.tool);
}

export function isSkippedDuplicateCreate(u: ToolUseLike): boolean {
  return u.ok && /skipped duplicate/i.test(u.summary) && (RAW_CREATE_TOOLS.has(u.tool) || /^create_huddle_tasks?$/.test(u.tool));
}

export function isSuggestionOnlyCreate(u: ToolUseLike): boolean {
  return u.ok && /^create_huddle_tasks?$/.test(u.tool) && (/^suggested\b/i.test(u.summary) || /Huddle-only/.test(u.summary));
}

/** A create that really wrote a row on the canonical board this turn. */
export function isPerformedCreate(u: ToolUseLike): boolean {
  if (!u.ok || NOT_PERFORMED_RE.test(u.summary)) return false;
  if (u.tool === "create_huddle_task") return u.summary.includes("→ Huddle board + journey");
  if (u.tool === "create_huddle_tasks") return /^created [1-9]\d*\/\d+ → Huddle board \+ journey/.test(u.summary);
  if (RAW_CREATE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary);
  return false;
}

/** A status/tag change (or delete) that really wrote this turn. */
export function isPerformedTaskChange(u: ToolUseLike): boolean {
  if (!u.ok || NOT_PERFORMED_RE.test(u.summary)) return false;
  if (STATUS_TOOLS.has(u.tool) || DELETE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary);
  return false;
}

/** Real WORK for the ask, done this turn: a specialist dispatched, a document saved, or a task row created.
 *  (A deduped delegation still counts: the delegation it duplicates happened earlier this same turn.) */
export function isPerformedWork(u: ToolUseLike): boolean {
  if (!u.ok) return false;
  if (u.tool === "delegate_to_specialist") return !/delegation failed/i.test(u.summary);
  if (u.tool === "create_artifact") return typeof u.detail === "string" && u.detail.startsWith("/artifacts/");
  return isPerformedCreate(u);
}

/** Did `agentId` do real work for the ask in this turn (F1: then nobody else is handed it)? */
export function agentPerformedWork(toolUses: readonly ToolUseLike[], agentId: string): boolean {
  return toolUses.some((u) => u.agentId === agentId && isPerformedWork(u));
}

// ---------------------------------------------------------------------------------------------------------------
// F6 presenter: an agent never claims a board action it did not perform (AC-handoff-confirm-flow.md F6, S-B rows).
// Observed 2026-10-29: Ezra said "I marked 'Order Nike Pegasus Premium' done" with no write (the task had been DONE
// since 09-01), and "I'm proceeding with the research" while the task sat in BACKLOG. Applied inside the existing
// turn presenter (presentedReplies), so every exit point — stream, chunk save, final result, the prior shown to the
// next agent, memory — sees the same corrected text. Pure and idempotent: replacement lines never match a claim.

const SENTENCE_SPLIT = /((?<=[.!?])\s+|\n+)/;
// Offers, plans, questions and capability statements are not claims (S-B5..S-B7).
const NOT_A_CLAIM_RE =
  /\b(?:I'll|I’ll|I will|I can|I could|I'd|I’d|want me to|shall I|should I|let me|going to|once you|if you)\b|\?\s*$/i;
// Non-board objects (S-B8..S-B10): email read state, notes, "noted".
const OFF_BOARD_RE = /\bas (?:read|unread)\b|\bemails?\b|\binbox\b|\bnotes?\b|\bnoted\b/i;
// A quoted request echoed back ("You asked me to "mark it done"") is not a claim (S-B13).
const QUOTED_RE = /["“][^"”]*\b(?:mark|move|add|archive)\w*\b[^"”]*["”]/i;
const BOARD_WORD_RE = /\b(?:done|complete(?:d)?|review|up next|backlog|doing|board|task|card|archived?|deleted)\b/i;
const STATUS_CLAIM_RE =
  /(?:^|\b(?:I|I've|I’ve|I have|I just|just)\s+)(?:marked|moved|set|put|archived|deleted|removed|closed|completed)\b/i;
const CREATE_CLAIM_RE = /(?:^|\b(?:I|I've|I’ve|I have|I just|just)\s+)(?:added|created)\b/i;
const STARTED_CLAIM_RE =
  /\b(?:I'm|I’m|I am)\s+(?:now\s+)?(?:proceeding|starting on|working on it|getting started)\b|\bI(?:'ve|’ve| have)\s+started\b/i;

export const BOARD_CLAIM_LINES = {
  notChanged: "Nothing was changed on the board for that.",
  deferred: "That change was passed to the task's owner; the board isn't updated yet.",
  notAdded: "Nothing was added to the board for that.",
  alreadyThere: "That's already on your board.",
  suggestionOnly: "That's a suggested card only; it isn't on your board yet.",
  notStarted: "Nothing has started on that yet.",
} as const;

type ClaimKind = "status" | "create" | "started";

function claimKind(sentence: string): ClaimKind | null {
  const s = sentence.trim().replace(/^(?:done|ok(?:ay)?|sure|great)\s*[—–\-:,!.]\s*/i, "");
  if (!s || NOT_A_CLAIM_RE.test(s) || OFF_BOARD_RE.test(s) || QUOTED_RE.test(s)) return null;
  if (STARTED_CLAIM_RE.test(s)) return "started";
  if (CREATE_CLAIM_RE.test(s) && BOARD_WORD_RE.test(s)) return "create";
  if (STATUS_CLAIM_RE.test(s) && (BOARD_WORD_RE.test(s) || /^(?:archived|deleted)\b/i.test(s))) return "status";
  return null;
}

/** The code-built line that replaces an unbacked claim, or null when the agent's own toolUses back it. */
export function boardClaimCorrection(kind: ClaimKind, agentUses: readonly ToolUseLike[]): string | null {
  if (kind === "status") {
    if (agentUses.some(isPerformedTaskChange)) return null;
    return agentUses.some(isDeferredStatusChange) ? BOARD_CLAIM_LINES.deferred : BOARD_CLAIM_LINES.notChanged;
  }
  if (kind === "create") {
    if (agentUses.some(isPerformedCreate)) return null;
    if (agentUses.some(isSkippedDuplicateCreate)) return BOARD_CLAIM_LINES.alreadyThere;
    if (agentUses.some(isSuggestionOnlyCreate)) return BOARD_CLAIM_LINES.suggestionOnly;
    return BOARD_CLAIM_LINES.notAdded;
  }
  if (agentUses.some(isPerformedWork) || agentUses.some(isPerformedTaskChange)) return null;
  return BOARD_CLAIM_LINES.notStarted;
}

/** F6: replace each sentence claiming an unperformed board action with a code-built line. Pure, idempotent. */
export function presentBoardClaims<R extends { agentId: string; text: string }>(
  replies: readonly R[],
  toolUses: readonly ToolUseLike[],
): R[] {
  return replies.map((r) => {
    const src = String(r.text ?? "");
    const agentUses = toolUses.filter((u) => u.agentId === r.agentId);
    const parts = src.split(SENTENCE_SPLIT);
    const used = new Set<string>();
    let changed = false;
    const out: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = parts[i] ?? "";
      const sep = parts[i + 1] ?? "";
      const kind = claimKind(sentence);
      const fix = kind ? boardClaimCorrection(kind, agentUses) : null;
      if (!fix) {
        out.push(sentence + sep);
        continue;
      }
      changed = true;
      if (!used.has(fix)) {
        used.add(fix);
        out.push(fix + sep);
      }
    }
    return changed ? { ...r, text: out.join("").trim() } : r;
  });
}
