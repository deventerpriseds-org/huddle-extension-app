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
// Deliberately import-light (capabilities.ts only, everything else dynamic) so the voice server
// module does not drag the turn engine's graph in behind it.

import { capabilityOwnerFor } from "../capabilities";

export interface TaskCaller {
  entra_object_id?: string;
  entra_email?: string;
}

/** Normalized title used for cross-turn/cross-run dedup. Must match on both surfaces or the same
 *  spoken and typed title would dedup differently. */
export function normalizeTaskTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
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

/**
 * The user's already-open task titles, normalized, for cross-turn dedup. Best-effort by design: a
 * failed read returns an empty set and must never block a create. The text engine caches this once per
 * turn; the voice executor calls it once per tool call (a voice turn creates at most one batch).
 */
export async function loadOpenTaskTitles(caller: TaskCaller | undefined): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const email = caller?.entra_email;
    if (!email) return set;
    const { resolveTaskEmail } = await import("../journey/identity");
    const resolved = (await resolveTaskEmail(caller ?? {})) ?? email;
    const { getTasksForUser } = await import("./tasks.server");
    for (const t of await getTasksForUser(resolved)) {
      if (t.title) set.add(normalizeTaskTitle(t.title));
    }
  } catch {
    /* dedup read is best-effort — never block a create on it */
  }
  return set;
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
