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

/** The summary minus a leading quoted task title, so a title like "Test-set Huddle-only mode" cannot read as a
 *  "not performed" marker (verify loop 7, 7-rest C1). Create summaries start with “<title>”. */
// Greedy to the LAST closing quote before the arrow, so a title with its own quotes inside
// (Test-say "hi" in Huddle-only mode) is removed whole (verify loop 8, 8-rest).
const afterTitle = (summary: string) => summary.replace(/^\s*["“][\s\S]*["”](?=\s*→)/, "");
const notPerformed = (u: ToolUseLike) => NOT_PERFORMED_RE.test(afterTitle(u.summary));

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
  if (!u.ok || notPerformed(u)) return false;
  if (u.tool === "create_huddle_task") return u.summary.includes("→ Huddle board + journey");
  if (u.tool === "create_huddle_tasks") return /^created [1-9]\d*\/\d+ → Huddle board \+ journey/.test(u.summary);
  if (RAW_CREATE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary);
  return false;
}

/** A status/tag change (or delete) that really wrote this turn. */
export function isPerformedTaskChange(u: ToolUseLike): boolean {
  if (!u.ok || notPerformed(u)) return false;
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

// ALLOWLIST (verify loop 7, VERIFY-handoff-confirm-flow-7-C7.md). Two loops of "catch the claim, minus the true
// statements we know about" each rewrote new true statements ("I set a reminder for the review at 3pm", "I've
// marked 2-4pm as blocked on your calendar", "I've started a draft for you"). A rewrite now needs a clause in one
// of a CLOSED set of shapes: FIRST PERSON (I / we, or a bare verb opening the clause), the TASK ITSELF as the
// object (it / the task / that card / a quoted title), and a board status or completion at the END of the clause.
// Anything else is left exactly as written. Passive statements ("It's been moved to Done", "That task is marked
// done already") are never rewritten: they describe state, which may already be true or be a teammate's doing.
const SENTENCE_SPLIT = /((?<=[.!?])\s+|\n+)/;
const CLAUSE_SPLIT = /\s*[,;:]\s+|\s+[—–-]\s+|\s+(?:and|so|but|then)\s+/i;
const LEAD_IN = /^(?:[^\p{L}\p{N}"'“‘]+|(?:done|ok|okay|sure thing|sure|great|all set|got it|yep|yes|alright|perfect)\b[\s!.]*)+/iu;
const SUBJ = "(?:(?:i|we|i've|we've|i have|we have)\\s+)?(?:(?:just|now|already|also|gone ahead and|went ahead and)\\s+)*";
const OBJ =
  "(?:it|that|this|them|both|all of them|\"[^\"]+\"|'[^']+'|“[^”]+”|‘[^’]+’|" +
  "(?:(?:the|that|this|your|those|these|both|all|all the|\\d+|two|three|four|five)\\s+)?(?:[\\w'-]+\\s+){0,2}(?:tasks?|cards?))";
const STATUS = "(?:done|complete|completed|finished|in review|review|up next|in progress|doing|backlog|archived|blocked)";
const END = "(?:\\s+(?:column|lane|list|on (?:your|the) board))?[.!]*$";
const STATUS_CLAIM_RES = [
  // "I marked it done", "moved three tasks into Up next", "I've updated the task to Done", "Marked done."
  new RegExp(`^${SUBJ}(?:marked|moved|set|put|changed|updated|switched|dragged|flipped)\\s+(?:${OBJ}\\s+)?(?:(?:to|as|into|in|over to)\\s+)?(?:the\\s+)?${STATUS}${END}`, "i"),
  // "I archived the task", "completed it", "I've archived both"
  new RegExp(`^${SUBJ}(?:archived|deleted|removed|closed|completed|finished)\\s+${OBJ}(?:\\s+out)?${END}`, "i"),
  // "I've checked that task off", "ticked off the task"
  new RegExp(`^${SUBJ}(?:checked|ticked|crossed)\\s+(?:${OBJ}\\s+off|off\\s+${OBJ})${END}`, "i"),
  // "I've scheduled the task for 3pm tomorrow", "moved the task to Thursday"
  new RegExp(`^${SUBJ}(?:scheduled|rescheduled|moved)\\s+(?:the|that|this|your)\\s+tasks?\\s+(?:for|to)\\s+[^,;]{1,40}${END}`, "i"),
];
const CREATE_CLAIM_RES = [
  // "I've added a task for the dentist", "created 3 new tasks"
  new RegExp(`^${SUBJ}(?:added|created)\\s+(?:(?:a|an|the|that|this|\\d+|two|three|four|five)\\s+)?(?:new\\s+)?(?:tasks?|cards?|to-?dos?)\\b[^,;]{0,60}${END}`, "i"),
  // "I added it to your board", "added 'Test-walk the dog' to your board"
  new RegExp(`^${SUBJ}(?:added|created)\\s+${OBJ}\\s+(?:to|on)\\s+(?:your|the)\\s+(?:board|backlog|task list|to-?do list)${END}`, "i"),
];
const STARTED_CLAIM_RES = [
  /^(?:i'm|i am)\s+(?:now\s+)?(?:proceeding with (?:it|that|this|the task|that task|this task|the work|the research)|working on it|starting on it|getting started(?: on it)?)[.!]*$/i,
  /^(?:i've|i have)\s+(?:already\s+)?started\s+(?:on\s+)?(?:it|that|this|the task|that task|this task|work on it|working on it)[.!]*$/i,
];

/** Huddle's own tools that change a task (alongside journey's TASK_WRITE_TOOLS). */
const HUDDLE_TASK_TOOLS = new Set([
  "create_artifact", // a task-linked artifact flips the task DOING -> IN_REVIEW (ensureReviewFlip)
  "groom_backlog", // ranks, tags, assigns, then the promote-only pass fills Up next
  "delegate_to_specialist",
  "flag_blocker", // sets the task BLOCKED
  "confirm_task_intent", // a confirmed task can start (Doing)
  "override_approach_gate",
]);
/**
 * Did a successful Huddle task tool really change the task? Decided per tool from the summaries huddle.functions.ts
 * records — never by scanning the summary's free text (verify loop 8 C7: every successful flag_blocker summary is
 * "blocked: <reason>", which the generic "not performed" words matched, so the truest "I marked it blocked" was
 * always rewritten; an artifact named "Huddle-only …" did the same). Failures are recorded ok:false.
 */
function huddleToolChangedTask(u: ToolUseLike): boolean {
  if (!u.ok || !HUDDLE_TASK_TOOLS.has(u.tool)) return false;
  if (/skipped duplicate$/i.test(u.summary)) return false;
  if (u.tool === "confirm_task_intent") return /^DoD confirmed$/.test(u.summary.trim());
  if (u.tool === "override_approach_gate") return !/^not approved\b/i.test(u.summary);
  return true;
}

/** Any change this agent really made to a task this turn — what backs a status claim. */
function changedATask(u: ToolUseLike): boolean {
  if (isPerformedTaskChange(u) || isPerformedCreate(u)) return true;
  return huddleToolChangedTask(u);
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

// Apostrophe look-alikes mapped to ', and trailing emoji/symbols dropped ("Marked as done ✅").
const normalizeClaimText = (t: string) =>
  t.replace(/[‘’ʼ`＇´]/g, "'").replace(/[^\p{L}\p{N}.!?'"”’)]+$/u, "").trim();

/** The claim a sentence makes, if one of its clauses is in the closed set of claim shapes (see ALLOWLIST above). */
function claimKind(sentence: string): ClaimKind | null {
  const s = normalizeClaimText(sentence);
  if (!s || /\?\s*$/.test(s) || QUOTED_RE.test(s)) return null;
  for (const raw of s.split(CLAUSE_SPLIT)) {
    const clause = raw.trim().replace(LEAD_IN, "").trim();
    if (!clause) continue;
    if (STARTED_CLAIM_RES.some((re) => re.test(clause))) return "started";
    if (STATUS_CLAIM_RES.some((re) => re.test(clause))) return "status";
    if (CREATE_CLAIM_RES.some((re) => re.test(clause))) return "create";
  }
  return null;
}

// A quoted request echoed back ("You asked me to "mark it done"") is not a claim (S-B13).
const QUOTED_RE = /["“][^"”]*\b(?:mark|move|add|archive|check)\w*\b[^"”]*["”]/i;

/**
 * The code-built line that replaces an unbacked claim, or null when the agent's OWN tool uses back it. Only
 * first-person claims reach here ("I marked it done"), so a teammate's write never backs them (S-B AC); a
 * teammate's move described passively ("It's been moved to Done") is not a claim at all. "started" is also
 * backed by any tool the agent ran that did not fail. `turnUses` is kept for callers; not used for backing.
 */
export function boardClaimCorrection(
  kind: ClaimKind,
  agentUses: readonly ToolUseLike[],
  turnUses: readonly ToolUseLike[] = agentUses,
): string | null {
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
  void turnUses;
  if (agentUses.some(changedATask) || agentUses.some((u) => u.ok && !notPerformed(u) && !/failed/i.test(u.summary)))
    return null;
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
      const fix = kind ? boardClaimCorrection(kind, agentUses, toolUses) : null;
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
