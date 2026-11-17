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
// Every journey tool that WRITES a task (journey-voice supabase/functions/_shared/tool-definitions.ts). A
// successful one backs a "moved / set / completed" claim. Verify loop 4 (C7): with only the two status tools,
// "I moved the task to Thursday" after a real move_task_to_day was rewritten to "Nothing was changed".
const TASK_WRITE_TOOLS = new Set([
  ...STATUS_TOOLS,
  "reschedule_task", "schedule_task", "unschedule_task", "move_task_to_day", "swap_task_order",
  "set_priority_rank", "rebuild_schedule", "focus_on",
]);
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
  if (TASK_WRITE_TOOLS.has(u.tool) || DELETE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary) || u.tool === "focus_on";
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

// WHICH DIRECTION IS UNSAFE. Rewriting a TRUE statement into "Nothing was changed" tells the owner a real change
// did not happen (verify loops 4 and 5 found 6+ of these each time); letting a false claim through is what F6
// exists to reduce, but it is the status quo before F6. So the presenter fails toward leaving the agent's words
// alone: (1) a claim must be EXPLICIT about the board — a status the board has, or the task itself completed /
// archived / checked off / scheduled — never a work statement ("I've completed the analysis", "I put the
// comparison on the card"); (2) ANY task-changing tool the agent ran this turn backs it, Huddle's own included
// (create_artifact flips the task to Review, groom_backlog ranks and fills Up next, flag_blocker → Blocked).
//
// SUPERSEDES the c94d1085 matcher (off-board word list + journey-only backing), refuted by verify loop 5 C7
// (docs/qc-evidence/VERIFY-handoff-confirm-flow-5-C7.md on claude_verify-handoff-confirm-flow-5-c7).

const SENTENCE_SPLIT = /((?<=[.!?])\s+|\n+)/;
// Inside a sentence, a dash starts a new clause: "That one's handled — marked it complete." (loop 5 N-M7).
// The claim is judged per clause; the whole sentence is still what gets replaced.
const CLAUSE_SPLIT = /\s+[—–]\s+/;
// Offers, plans and capability statements are not claims (S-B5..S-B7) — but only when they come BEFORE the
// claim verb: "I've marked it done, let me know if you need anything" is a claim (loop 5 N-M1/N-M2).
const OFFER_RE =
  /\b(?:I'll|I’ll|I will|I can|I could|I'd|I’d|I would|want me to|shall I|should I|let me|going to|once you|if you|happy to|ready to)\b/i;
// A quoted request echoed back ("You asked me to "mark it done"") is not a claim (S-B13).
const QUOTED_RE = /["“][^"”]*\b(?:mark|move|add|archive|check)\w*\b[^"”]*["”]/i;

const SUBJECT =
  "(?:^|\\b(?:I|we|I've|I’ve|I have|we've|we’ve|we have)\\s+(?:(?:just|now|already|also|gone ahead and|went ahead and)\\s+)?" +
  "|\\b(?:it's|it’s|it is|it has|it's been|it’s been|it has been|that's|that’s)\\s+(?:now\\s+)?(?:been\\s+)?" +
  "|\\b(?:your |the |that |this )?(?:task|card|item|one)\\s+(?:is|was|has been|'s been|’s been|'s|’s)?\\s*(?:now\\s+)?(?:been\\s+)?)";
const TASK_OBJ = "(?:the |that |this |your |both |all )?(?:(?:\\w+\\s+){0,2}tasks?|cards?|items?|it|that|this|them|one)";
// A status the board actually has.
const STATUS_TARGET = "(?:done|complete|completed|finished|in review|review|up next|in progress|doing|backlog|blocked|archived|parked|parking lot)";
const STATUS_CLAIM_RE = new RegExp(
  [
    // "marked it done", "moved three tasks into Up next", "updated the task to Done", "set it as blocked"
    `${SUBJECT}(?:marked|moved|set|put|changed|updated|switched|flipped|shifted|bumped|dragged)\\s+(?:[\\w'’-]+\\s+){0,5}?(?:(?:to|as|into|in|on)\\s+)?(?:the\\s+)?${STATUS_TARGET}\\b`,
    // "archived the task", "completed it", "deleted that card"
    `${SUBJECT}(?:archived|deleted|removed|closed|completed|finished)\\s+${TASK_OBJ}\\b`,
    // "checked that task off", "ticked it off"
    `${SUBJECT}(?:checked|ticked|crossed)\\s+${TASK_OBJ}\\s+off\\b`,
    `${SUBJECT}(?:checked|ticked|crossed)\\s+off\\s+${TASK_OBJ}\\b`,
    // "scheduled the task for 3pm", "moved the task to Thursday"
    `${SUBJECT}(?:scheduled|rescheduled|moved)\\s+(?:the |that |this |your )?tasks?\\b`,
    // a bare opener: "Marked done.", "Archived."
    `^(?:marked|moved)\\s+(?:[\\w'’-]+\\s+){0,3}?(?:(?:to|as|into)\\s+)?${STATUS_TARGET}\\b`,
    `^(?:archived|deleted)\\b`,
  ].join("|"),
  "i",
);
// "added a task", "created two new cards", "added it to your board"
const CREATE_CLAIM_RE = new RegExp(
  `${SUBJECT}(?:added|created)\\s+(?:(?:a|an|the|that|this|two|three|\\d+)\\s+)?(?:new\\s+)?(?:tasks?|cards?|to-?dos?)\\b` +
    `|${SUBJECT}(?:added|created)\\s+(?:(?:it|that|this|them|[\\w'’-]+(?:\\s+[\\w'’-]+){0,3})\\s+)?(?:to|on)\\s+(?:your|the)\\s+(?:board|backlog|task list|to-?do list)\\b`,
  "i",
);
const STARTED_CLAIM_RE =
  /\b(?:I'm|I’m|I am)\s+(?:now\s+)?(?:proceeding|starting on|working on it|getting started)\b|\bI(?:'ve|’ve| have)\s+started\b/i;

/** Huddle's own tools that change a task (alongside journey's TASK_WRITE_TOOLS). */
const HUDDLE_TASK_TOOLS = new Set([
  "create_artifact", // a task-linked artifact flips the task DOING -> IN_REVIEW (ensureReviewFlip)
  "groom_backlog", // ranks, tags, assigns, then the promote-only pass fills Up next
  "delegate_to_specialist",
  "flag_blocker", // sets the task BLOCKED
  "confirm_task_intent", // a confirmed task can start (Doing)
  "override_approach_gate",
]);
/** Any change this agent really made to a task this turn — what backs a status claim. */
function changedATask(u: ToolUseLike): boolean {
  if (isPerformedTaskChange(u) || isPerformedCreate(u)) return true;
  return u.ok && HUDDLE_TASK_TOOLS.has(u.tool) && !NOT_PERFORMED_RE.test(u.summary) && !/failed/i.test(u.summary);
}

export const BOARD_CLAIM_LINES = {
  notChanged: "Nothing was changed on the board for that.",
  deferred: "That change was passed to the task's owner; the board isn't updated yet.",
  notAdded: "Nothing was added to the board for that.",
  alreadyThere: "That's already on your board.",
  suggestionOnly: "That's a suggested card only; it isn't on your board yet.",
  notStarted: "Nothing has started on that yet.",
} as const;

type ClaimKind = "status" | "create" | "started";

/** The claim a sentence makes, judged only on the text up to the claim (an offer AFTER it does not cancel it). */
function claimKind(sentence: string): ClaimKind | null {
  for (const clause of sentence.split(CLAUSE_SPLIT)) {
    const k = clauseClaimKind(clause);
    if (k) return k;
  }
  return null;
}

function clauseClaimKind(clause: string): ClaimKind | null {
  const s = clause
    .trim()
    .replace(/^[\s✅☑️✔️👍]+/u, "")
    .replace(/^(?:done|ok(?:ay)?|sure|great|all set)\s*[—–\-:,!.]\s*/i, "");
  if (!s || /\?\s*$/.test(s) || QUOTED_RE.test(s)) return null;
  const before = (m: RegExpExecArray | null) => (m ? s.slice(0, m.index + m[0].length) : null);
  for (const [kind, re] of [
    ["started", STARTED_CLAIM_RE],
    ["status", STATUS_CLAIM_RE],
    ["create", CREATE_CLAIM_RE],
  ] as const) {
    const upTo = before(re.exec(s));
    if (upTo !== null && !OFFER_RE.test(upTo)) return kind;
  }
  return null;
}

/** The code-built line that replaces an unbacked claim, or null when the agent's own toolUses back it. */
export function boardClaimCorrection(kind: ClaimKind, agentUses: readonly ToolUseLike[]): string | null {
  if (kind === "status") {
    if (agentUses.some(changedATask)) return null;
    return agentUses.some(isDeferredStatusChange) ? BOARD_CLAIM_LINES.deferred : BOARD_CLAIM_LINES.notChanged;
  }
  if (kind === "create") {
    if (agentUses.some(isPerformedCreate)) return null;
    if (agentUses.some(isSkippedDuplicateCreate)) return BOARD_CLAIM_LINES.alreadyThere;
    if (agentUses.some(isSuggestionOnlyCreate)) return BOARD_CLAIM_LINES.suggestionOnly;
    return BOARD_CLAIM_LINES.notAdded;
  }
  if (agentUses.some(isPerformedWork) || agentUses.some(changedATask)) return null;
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
