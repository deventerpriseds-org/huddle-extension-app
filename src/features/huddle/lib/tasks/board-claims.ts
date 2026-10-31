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
