// WHAT:       The surface-independent core of Huddle task creation — the exclusive-capability
//             meta-task guard, cross-turn title dedup, journey date normalization, and the honest
//             scheduled/deferred outcome note. ONE implementation, called by BOTH the text turn
//             engine (createSuggestedTaskFromTool / createBatchTasksFromTool in huddle.functions.ts)
//             and the voice executor (executeRealtimeTool in voice/realtime-tools.server.ts).
// WHY:        BATCH-3-RESULTS.md measured create_huddle_task as text-only: a spoken "add that to my
//             board" could not create a Huddle card. Voice reached only journey's raw
//             quick_create_task, which skips every guard above. Adding those guards a SECOND time
//             inside the voice executor is exactly the parallel-system failure the org rule forbids,
//             so the shared half was extracted here instead and both callers were pointed at it.
// SUPERSEDES: nothing. The guards previously lived inline in the two huddle.functions.ts closures;
//             those closures now call these helpers. What stays in the closures is turn-scoped and
//             genuinely not shareable: the SuggestedTaskDraft board cards, recordToolUse breadcrumbs,
//             recordFallback events, and the per-turn createdTaskTitles ledger.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/FIX-voice-capability-gaps.md (nexus-hub); proved by
//             scripts/voice-toolset-hidden.test.ts.
//
// 2026-10-27 (AC-confirm-ask-rotation.md section D): also the home of the ONE raw-journey-create
// dedup interception (screenRawJourneyCreate) that the text OpenAI/Lovable dispatch, the voice
// catalog router and the produce path all call; and loadOpenTaskTitles now fails open LOUDLY.
// Log: .claude/IMPL-create-dedup.md.
//
// Deliberately import-light (capabilities.ts + the dependency-free scoring.ts only, everything else
// dynamic) so the voice server module does not drag the turn engine's graph in behind it.

import { capabilityOwnerFor } from "../capabilities";
// The ONE normalizer (AC-65) is defined in scoring.ts (a dependency-free leaf) and re-exported here,
// so every existing `import { normalizeTaskTitle } from "./tasks/create-task-core"` keeps working and
// there is no second definition to drift. See scoring.ts for the rule (OQ-7).
import { normalizeTaskTitle } from "./scoring";
export { normalizeTaskTitle };

export interface TaskCaller {
  entra_object_id?: string;
  entra_email?: string;
}

/**
 * journey's `date` / `target_date` param only understands 'today' | 'tomorrow' | YYYY-MM-DD. Anything
 * else the model supplies (a weekday name, "next Friday") must be DROPPED so the title-text NL parser
 * handles it instead — passing it through silently breaks scheduling. Defense in depth: the tool
 * description says the same thing, and a small model ignores it.
 */
export function normalizeJourneyDate(raw: unknown): string | undefined {
  const d = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return d === "today" || d === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

export interface CapabilityDeferral {
  /** The agent the job belongs to, or undefined when the CALLER itself owns it (self-restatement). */
  handedTo?: string;
  /** True when the filer owns the capability — it is their job to DO, not to card. */
  isSelf: boolean;
  /** Human-readable reason, for the batch path's `deferred[]` rows. */
  reason: string;
  /** Instruction to the model, for the single path's `note`. */
  note: string;
}

/**
 * Exclusive-capability meta-task guard. A non-owner must not file a card that merely restates another
 * agent's EXCLUSIVE job (Iris filing "Groom and triage the backlog" — Terry's), and an OWNER must not
 * file a card restating its OWN job right after performing it (the 2026-07-31 board-pollution
 * incident). Fires only when the TITLE ITSELF matches a capability trigger, so a genuine to-do
 * ("renew passport") matches nothing and is untouched. Data-driven off agents.ts capabilities, so it
 * covers every agent with no per-agent code — and now every SURFACE with no per-surface code.
 */
export function screenCapabilityMetaTask(
  title: string,
  callerAgentId: string,
): CapabilityDeferral | null {
  const owner = capabilityOwnerFor(title);
  if (!owner) return null;
  const isSelf = owner.agent.id === callerAgentId;
  return {
    handedTo: isSelf ? undefined : owner.agent.id,
    isSelf,
    reason: isSelf
      ? `${owner.cap.label} is your own job to perform, not a card`
      : `${owner.cap.label} belongs to ${owner.agent.name}`,
    note: isSelf
      ? `That's your own job to perform, not a task to file — do it, don't card it.`
      : `That's ${owner.agent.name}'s exclusive job — it's been handed to them; do not file a task about it.`,
  };
}

/** Result of the open-title read. `unavailable` is non-null when the read FAILED — the set is then
 *  empty and every caller must say so out loud (recordFallback / a tool-use note), never treat it as
 *  "no duplicates". */
export interface OpenTitleLoad {
  titles: Set<string>;
  unavailable: string | null;
}

/**
 * The user's already-open task titles, normalized, for cross-turn dedup. "Open" = not DONE and not
 * completed; BLOCKED tasks ARE included (owner OQ-8), because re-creating a blocked task still makes a
 * duplicate card. DONE tasks never block a re-create (AC-63). Dedup is per USER, across every agent
 * (AC-61) — the set is the user's whole board, not one agent's lane.
 *
 * FAIL-OPEN BUT LOUD (owner OQ-6 / AC-64). A failed read must never block a create (a refused create
 * is a lost user request; a duplicate is one cleanup row), but it used to fail SILENTLY: every error
 * became an empty set and the create looked deduped when no check had run. It now returns the reason
 * in `unavailable`, logs it, and each caller records a visible "dedup unavailable" event.
 *
 * The text engine caches this once per turn; the voice executor calls it once per tool call.
 */
export async function loadOpenTaskTitles(caller: TaskCaller | undefined): Promise<OpenTitleLoad> {
  const titles = new Set<string>();
  const email = caller?.entra_email;
  // No caller identity: there is no board to compare against (and no journey write will follow on the
  // text path, which gates on the same email). Not a failure, so not reported as one.
  if (!email) return { titles, unavailable: null };
  try {
    const { resolveTaskEmail } = await import("../journey/identity");
    const resolved = (await resolveTaskEmail(caller ?? {})) ?? email;
    const { getTasksForUser } = await import("./tasks.server");
    for (const t of await getTasksForUser(resolved, undefined, { includeBlocked: true })) {
      if (t.title) titles.add(normalizeTaskTitle(t.title));
    }
    return { titles, unavailable: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[task-dedup] open-title read failed — creating WITHOUT a duplicate check: ${reason}`);
    return { titles: new Set<string>(), unavailable: reason || "open-title read failed" };
  }
}

// ── Raw journey create interception (AC-55..AC-61, AC-67) ────────────────────────────────────────
//
// F14: journey's own catalog offers `quick_create_task` / `parse_and_create_tasks` / `create_task`
// on EVERY surface (text OpenAI dispatch, text Lovable dispatch, the voice catalog router) and the
// produce path calls `quick_create_task` directly. None of those went through create_huddle_task's
// dedup, and journey itself does not dedup (execute-tool parseAndCreateTasks inserts every parsed
// task). This is the ONE interception all four sites call, beside the existing
// maybeDeferStatusChange hook, so the rule cannot diverge between them.

/** journey catalog tools that CREATE tasks. `create_task` is journey's legacy name, redirected to
 *  parseAndCreateTasks server-side (execute-tool :338), so it is a create too. */
export const RAW_JOURNEY_CREATE_TOOLS: ReadonlySet<string> = new Set([
  "quick_create_task",
  "parse_and_create_tasks",
  "create_task",
]);

/** The per-turn `createdTaskTitles` ledger shape (a Set satisfies it). */
export interface TitleLedger {
  has(key: string): boolean;
  add(key: string): unknown;
}

export type RawCreateSkip = { title: string; reason: string };

export type RawCreateDecision =
  /** Not a create tool (or nothing to screen): dispatch exactly as before. */
  | { action: "pass" }
  /** Dispatch to journey with `args` — the original args, or a batch with duplicates removed. */
  | { action: "forward"; args: Record<string, unknown>; skipped: RawCreateSkip[]; dedupUnavailable: string | null }
  /** Do NOT call journey. `result` is what the model gets back, the same shape create_huddle_task /
   *  create_huddle_tasks already return for a duplicate. */
  | { action: "skip"; result: Record<string, unknown>; skipped: RawCreateSkip[]; dedupUnavailable: string | null };

const DUP_THIS_TURN = "already created this turn";
const DUP_ON_BOARD = "an open task with this title already exists";

/**
 * Screen a raw journey tool call for duplicate task creates. Non-create tools return `pass` WITHOUT
 * reading anything (AC-67). Creates are checked against the per-turn ledger first (AC-60: a raw create
 * after create_huddle_task in the same turn collides) and then the user's open titles (AC-55, AC-61);
 * every surviving title is claimed in the ledger so a later create in the same turn collides with it.
 * A batch forwards ONLY its non-duplicates (AC-59) and is skipped outright when all are duplicates.
 * When the open-title read failed, the create proceeds and `dedupUnavailable` carries the reason so
 * the caller can record it (AC-64).
 */
export async function screenRawJourneyCreate(
  toolName: string,
  rawArgs: unknown,
  deps: { ledger: TitleLedger; loadTitles: () => Promise<OpenTitleLoad> },
): Promise<RawCreateDecision> {
  if (!RAW_JOURNEY_CREATE_TOOLS.has(toolName)) return { action: "pass" };
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const isBatch = toolName === "parse_and_create_tasks";
  const entries = isBatch
    ? splitTaskEntries(args)
    : [String(args.title ?? args.task ?? args.name ?? "").trim()].filter(Boolean);
  // Nothing to screen (journey will reject a title-less create itself) — leave it untouched.
  if (entries.length === 0) return { action: "pass" };

  const load = await deps.loadTitles();
  const survivors: string[] = [];
  const skipped: RawCreateSkip[] = [];
  for (const entry of entries) {
    const key = normalizeTaskTitle(entry);
    if (deps.ledger.has(key)) {
      skipped.push({ title: entry, reason: DUP_THIS_TURN });
      continue;
    }
    if (load.titles.has(key)) {
      deps.ledger.add(key);
      skipped.push({ title: entry, reason: DUP_ON_BOARD });
      continue;
    }
    deps.ledger.add(key);
    survivors.push(entry);
  }
  const dedupUnavailable = load.unavailable;

  if (!isBatch) {
    if (survivors.length === 1) return { action: "forward", args, skipped, dedupUnavailable };
    // Byte-identical to create_huddle_task's duplicate return.
    return {
      action: "skip",
      result: { ok: true, deduped: true, task: { title: entries[0].slice(0, 160) } },
      skipped,
      dedupUnavailable,
    };
  }
  if (survivors.length === 0) {
    // Same shape as create_huddle_tasks when every entry was a duplicate.
    return {
      action: "skip",
      result: { ok: true, requested: entries.length, created: 0, deferred: [], skipped, tasks: [] },
      skipped,
      dedupUnavailable,
    };
  }
  if (skipped.length === 0) return { action: "forward", args, skipped, dedupUnavailable };
  // Partial: forward only the survivors, in whichever field the model used (splitTaskEntries prefers
  // a `tasks` array, so rewrite that if it was the source; otherwise the text blob).
  const forwarded: Record<string, unknown> = Array.isArray(args.tasks)
    ? { ...args, tasks: survivors }
    : { ...args, text: survivors.join("\n") };
  return { action: "forward", args: forwarded, skipped, dedupUnavailable };
}

/** One-line tool-use summary for a skipped raw create. */
export function describeRawCreateSkip(skipped: RawCreateSkip[]): string {
  return `skipped duplicate — ${skipped
    .map((s) => `“${s.title.slice(0, 60)}” (${s.reason})`)
    .join(", ")}`;
}

/**
 * Tell the model about what the interception did to a FORWARDED create: entries removed as duplicates
 * from a batch, and/or that no duplicate check ran. journey's output is a JSON object string; the note
 * rides on it as extra fields. Anything unparseable is returned untouched (never corrupt a result).
 */
export function annotateRawCreateOutput(output: string, decision: RawCreateDecision): string {
  if (decision.action === "pass") return output;
  if (decision.skipped.length === 0 && !decision.dedupUnavailable) return output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
    const extra: Record<string, unknown> = {};
    if (decision.skipped.length) extra.skipped_duplicates = decision.skipped;
    if (decision.dedupUnavailable) {
      extra.dedup_note =
        "dedup unavailable — the duplicate check could not run, so this was created without it";
    }
    return JSON.stringify({ ...(parsed as Record<string, unknown>), ...extra });
  } catch {
    return output;
  }
}

/**
 * Parse journey's `quick_create_task` result into an honest outcome note. journey's `output` IS
 * execute-tool's `result` object verbatim, so same-day placement is PROVISIONAL until the nightly
 * planner runs and a future due date has no exact time yet. Without this the model reports a flat
 * "added it" that overclaims what actually happened.
 */
export function summarizeQuickCreateOutcome(output: string): {
  outcome?: { due_date?: string | null; start_time?: string | null; is_scheduled?: boolean };
  note?: string;
} {
  try {
    const parsed = JSON.parse(output) as {
      scheduled?: Array<{ title: string; time: string }>;
      deferredToNightly?: Array<{ title: string; due_date: string }>;
      tasks?: Array<{ due_date?: string | null; start_time?: string | null; is_scheduled?: boolean }>;
    };
    const outcome = parsed.tasks?.[0];
    let note: string | undefined;
    if (parsed.scheduled && parsed.scheduled.length > 0) {
      note = `scheduled at ${parsed.scheduled[0].time} today (provisional — the nightly planner may move it)`;
    } else if (parsed.deferredToNightly && parsed.deferredToNightly.length > 0) {
      note = `due ${parsed.deferredToNightly[0].due_date} — no exact time yet, the nightly planner will place one`;
    } else if (outcome?.due_date && !outcome.start_time) {
      note = `due ${outcome.due_date} — no exact time yet`;
    } else if (!outcome?.due_date && !outcome?.start_time) {
      note = "added to the backlog, unscheduled";
    }
    return { outcome, note };
  } catch {
    return {};
  }
}

/** Split a multi-task blob for journey's NL parser. Only hard separators, so a compound SINGLE task
 *  ("call the bank and ask about the fee") is not torn apart. */
export function splitTaskEntries(args: Record<string, unknown>): string[] {
  const list = Array.isArray(args.tasks)
    ? (args.tasks as unknown[]).map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (list.length) return list;
  const blob = typeof args.text === "string" ? args.text.trim() : "";
  if (!blob) return [];
  const parts = blob
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [blob];
}
