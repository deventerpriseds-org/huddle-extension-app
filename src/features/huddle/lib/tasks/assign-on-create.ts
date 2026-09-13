// WHAT:       Decides WHO a newly-created board task should be assigned to, and resolves a
//             model-supplied owner string to a REAL roster id (or nothing at all).
// WHY:        A task the owner handed straight to an agent landed with `assigned_agent = NULL`, so
//             the entire auto-work engine skipped it — `autowork.server.ts:544`
//             (`if (!agent || !AGENT_BY_ID[agent]) continue;`) drops it from the WIP buckets and
//             `:370` (`if (!row.assigned_agent) continue;`) drops it from the confirm reach-outs.
//             It stayed inert until the next groom. An owner WAS resolved at
//             `huddle.functions.ts:2649` and then used only to draw the local UI card; the canonical
//             journey write never carried it. Owner: assignment "should have happened immediately
//             just like grooming but from my direct ask of the task to an agent."
// SUPERSEDES: nothing -- this is the shared half, so the two creating call sites
//             (createSuggestedTaskFromTool and the 1:1 produce path) cannot drift apart.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/actions.md "ACT:assign-on-direct-ask"; scripts/assign-on-create.test.ts
//
// NO NODE IMPORTS AT MODULE SCOPE. `huddle.functions.ts` imports this, and it must stay runnable by
// `bun scripts/assign-on-create.test.ts` with no database and no server runtime. The journey call
// below imports its transport DYNAMICALLY, inside the function, exactly like every other journey
// call site — so importing this module never pulls the server bundle in.

/** The minimum an agent record needs for owner matching. Passed in, never imported, so the pure
 *  half of this module has zero dependencies and the test can hand it the REAL roster. */
export interface OwnerRosterEntry {
  id: string;
  name: string;
  handle: string;
}

/**
 * Resolve a model-supplied owner string ("finn", "Finn Reid", "finn-reid") to a real roster id.
 *
 * Returns **null** when nothing was supplied or nothing matched — it NEVER falls back to a default.
 * That distinction is the whole point: `resolveTaskOwner` in huddle.functions.ts falls back to the
 * responding agent, so its result can never tell you whether the agent actually NAMED an owner. In a
 * GROUP huddle we only assign when one was genuinely named, so the caller needs the un-defaulted
 * answer.
 *
 * Matching mirrors the long-standing `resolveTaskOwner` chain (exact id, exact name, exact handle,
 * then substring either way) so the card's owner and the journey assignee can never disagree — this
 * function is now the single implementation and `resolveTaskOwner` is `this ?? winner.id`.
 *
 * ONE deliberate tightening: the loose substring branches require at least 2 characters. A 1-char
 * model slip ("a") previously matched the first agent whose name contained that letter — harmless
 * when it only tinted a UI card, not harmless now that it writes a canonical assignment.
 */
export function resolveExplicitOwner(value: unknown, roster: OwnerRosterEntry[]): string | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const exact = roster.find(
    (a) => a.id.toLowerCase() === raw || a.name.toLowerCase() === raw || a.handle.toLowerCase() === raw,
  );
  if (exact) return exact.id;
  if (raw.length < 2) return null;
  const fuzzy = roster.find(
    (a) => a.name.toLowerCase().includes(raw) || raw.includes(a.handle.toLowerCase()),
  );
  return fuzzy?.id ?? null;
}

/** A huddle is a 1:1 either because the turn says so or because its id is a DM id. */
export function isOneToOne(scope: string | undefined, huddleId: string | undefined): boolean {
  return scope === "one-to-one" || String(huddleId ?? "").startsWith("dm-");
}

/**
 * WHO gets the new task. Owner-decided, and the group case is deliberately conservative:
 *
 *  - **1:1** → the RESPONDING agent. You asked that agent directly, in its own room; it is the
 *    natural owner, and there is nobody else in the room to mean instead.
 *  - **group** → ONLY an explicitly named owner. `huddle.functions.ts:2221` makes the LEAD capture
 *    items across every lane, so defaulting to the responder would file other lanes' work against
 *    the wrong agent — worse than leaving it for grooming, which at least reads the content.
 *
 * Returning null means "leave it unassigned", i.e. exactly today's behaviour.
 */
export function pickCreatedTaskAssignee(opts: {
  scope: string | undefined;
  huddleId: string | undefined;
  responderId: string | null | undefined;
  explicitOwner: string | null;
}): string | null {
  if (opts.explicitOwner) return opts.explicitOwner;
  if (!isOneToOne(opts.scope, opts.huddleId)) return null;
  return opts.responderId ? opts.responderId : null;
}

/** What the follow-up assignment actually did. Reported back to the model verbatim so it can never
 *  claim an assignment that did not happen. */
export interface AssignOutcome {
  /** true only when at least one journey row was really updated. */
  assigned: boolean;
  agentId: string | null;
  /** journey task ids the update succeeded for. */
  taskIds: string[];
  /** present when something went wrong; the create still stands. */
  error?: string;
  /** one line for the tool result / breadcrumb. */
  note: string;
}

/** Never issue more than this many follow-up updates from one create. `quick_create_task` normally
 *  returns exactly one row; the cap is a guard against a parser that split a title into many. */
const MAX_ASSIGN_UPDATES = 10;

/**
 * Best-effort follow-up assignment for rows `quick_create_task` just created.
 *
 * THE ARG NAMES ARE READ, NOT GUESSED: journey's `updateTask` opens with
 * `if (!args.task_id) return {success:false, error:"Task ID is required"}`
 * (`execute-tool/index.ts:900`) and writes the assignee from `args.assigned_agent` (`:906-908`).
 * The same shape the board drag already sends (`tasks/board.functions.ts:56`). No journey deploy.
 *
 * `update_task` (singular) is used rather than `batch_update_tasks` because the batch returns
 * `success:true` even when every row failed (`execute-tool/index.ts:985-989`) — its `ok` would be
 * worthless as evidence, and this result is reported to the model as fact.
 *
 * NON-FATAL, ALWAYS. A throw or an error here leaves the task created-but-unassigned, which is
 * precisely today's behaviour — it can never fail the create.
 */
export async function assignCreatedJourneyTasks(params: {
  taskIds: string[];
  agentId: string;
  caller: Record<string, unknown>;
  huddleId?: string;
}): Promise<AssignOutcome> {
  const ids = params.taskIds.filter((id) => typeof id === "string" && id.trim()).slice(0, MAX_ASSIGN_UPDATES);
  if (!ids.length) {
    return {
      assigned: false,
      agentId: params.agentId,
      taskIds: [],
      error: "journey returned no task id to assign",
      note: "NOT assigned to anyone — journey did not echo a task id, so the row is unassigned until grooming picks it up. Do not tell the user it was assigned.",
    };
  }
  try {
    const { invokeJourneyTool } = await import("../journey/proxy.functions");
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await invokeJourneyTool({
            toolName: "update_task",
            args: { task_id: id, assigned_agent: params.agentId },
            caller: (params.caller ?? {}) as { entra_object_id?: string; entra_email?: string },
            context: { source: "huddle" as const, huddleId: params.huddleId },
          });
          return { id, ok: !!r.ok, error: r.error ?? "" };
        } catch (err) {
          return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const done = results.filter((r) => r.ok).map((r) => r.id);
    const failed = results.filter((r) => !r.ok);
    if (done.length) {
      return {
        assigned: true,
        agentId: params.agentId,
        taskIds: done,
        error: failed.length ? failed[0].error : undefined,
        note: `assigned to ${params.agentId}`,
      };
    }
    const why = failed[0]?.error || "unknown error";
    return {
      assigned: false,
      agentId: params.agentId,
      taskIds: [],
      error: why,
      note: `NOT assigned — the assignment write failed (${why}). The task EXISTS but has no owner yet. Do not tell the user it was assigned.`,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      assigned: false,
      agentId: params.agentId,
      taskIds: [],
      error: why,
      note: `NOT assigned — the assignment write crashed (${why}). The task EXISTS but has no owner yet. Do not tell the user it was assigned.`,
    };
  }
}
