// Approach gate — extends the hardened review gate to the START of work, not just the end (relearned
// 2026-08-05: a task can reach a finished, review-gated deliverable while the PLAN behind it was never
// checked for soundness or value — the review gate only grades the artifact, not the approach that
// produced it). AFTER confirm_task_intent locks the Definition of Done with the user, the assigned
// agent drafts an APPROACH (the how — method, sources, structure) and this gate grades it pass/revise,
// bounded by a configurable per-agent cap (identity/agent-workflow-config.server.ts). Mirrors
// review-gate.server.ts's shape exactly, just gating task ENTRY instead of task EXIT — and unlike the
// review gate, this step is entirely invisible to the user (no ask, no message) unless the cap is
// exhausted, at which point the caller escalates by telling the user directly instead of looping.

import { WORKERS } from "../agents/workers";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    deficiencies: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "deficiencies"],
  additionalProperties: false,
} as const;

const REVIEWER_MODEL = "gpt-4o-mini";

export interface ApproachGateResult {
  /** false = requireStructuredWorkflow is OFF for this agent — the gate did not run at all. */
  gated: boolean;
  /** true = the approach is approved; the task is now eligible for real DOING work. */
  approved: boolean;
  /** true = the cap was exhausted without a pass — tell the user directly, don't keep looping. */
  escalated: boolean;
  /** Human-facing summary, for recordToolUse. */
  note: string;
  deficiencies?: string[];
}

/**
 * Grade one proposed approach. `claim` should be the turn's existing turnActionLedger.claimAction —
 * keyed on (taskId, approach_revision_count) so a second concurrent dispatch in the same turn can't
 * double-grade or double-increment the counter (mirrors runReviewGate exactly).
 */
export async function runApproachGate(opts: {
  taskId: string;
  agentId: string;
  email: string;
  taskTitle: string;
  approach: string;
  claim: (key: string) => boolean;
}): Promise<ApproachGateResult> {
  const { isStructuredWorkflowRequired, getWorkflowCaps } = await import("../identity/agent-workflow-config.server");
  const required = await isStructuredWorkflowRequired(opts.email, opts.agentId).catch(() => false);
  if (!required) return { gated: false, approved: true, escalated: false, note: "" };

  const {
    getTaskEngagementState,
    incrementApproachRevisionCount,
    approveApproach,
    escalateApproach,
  } = await import("./tasks.server");
  const state = await getTaskEngagementState(opts.taskId).catch(() => null);

  if (state?.approach_status === "approved") {
    return { gated: true, approved: true, escalated: false, note: "already approved" };
  }
  if (state?.approach_status === "escalated") {
    return { gated: true, approved: false, escalated: true, note: "already escalated to the user — address it with them directly" };
  }

  const revisionCount = state?.approach_revision_count ?? 0;
  if (!opts.claim(`approach_gate:${opts.taskId}:${revisionCount}`)) {
    return { gated: true, approved: false, escalated: false, note: "approach review already in flight this turn" };
  }

  const caps = await getWorkflowCaps(opts.email, opts.agentId).catch(() => ({ approach: 3, review: 3, question: 2 }));

  try {
    const { callOpenAIRouter } = await import("../openai-responses.server");
    const reviewer = WORKERS["assignment-reviewer"];
    const dod = state?.confirmed_dod?.trim();
    const verdict = await callOpenAIRouter<{ verdict: "pass" | "revise"; deficiencies: string[] }>({
      model: REVIEWER_MODEL,
      system: reviewer.charter,
      prompt:
        "Grade this PLANNED APPROACH — no work has started yet, this is not a finished deliverable. Is " +
        "it sound (will this method actually reach the Definition of Done?) and is it high-value (worth " +
        "the effort, scoped at the right depth — not over-built, not superficial)? Call out anything " +
        "that would waste the team's time if they proceeded on this plan as-is.\n\n" +
        `Task: ${opts.taskTitle}\n\n` +
        (dod
          ? `Definition of Done it must reach:\n${dod}\n\n`
          : "No Definition of Done was confirmed for this task — grade the approach's fit to the task alone.\n\n") +
        `Proposed approach:\n${opts.approach.slice(0, 4000)}`,
      schema: VERDICT_SCHEMA,
      schemaName: "approach_review_verdict",
    });

    if (verdict.verdict === "pass") {
      await approveApproach(opts.taskId, opts.email, opts.approach).catch(() => {});
      return { gated: true, approved: true, escalated: false, note: "approach approved" };
    }
    if (revisionCount + 1 < caps.approach) {
      await incrementApproachRevisionCount(opts.taskId, opts.email).catch(() => {});
      return {
        gated: true,
        approved: false,
        escalated: false,
        note: `revise — ${verdict.deficiencies.slice(0, 3).join("; ")}`,
        deficiencies: verdict.deficiencies,
      };
    }
    // Cap exhausted — escalate to the user instead of looping forever or silently proceeding on an
    // approach the gate never actually approved.
    await escalateApproach(opts.taskId, opts.email).catch(() => {});
    return {
      gated: true,
      approved: false,
      escalated: true,
      note: `couldn't land on a sound approach after ${caps.approach} tries — flagged: ${verdict.deficiencies.slice(0, 3).join("; ")}`,
      deficiencies: verdict.deficiencies,
    };
  } catch (err) {
    // The grading call itself errored/timed out — fail open to autonomy (approve) rather than block
    // the task on a gate outage, mirroring review-gate.server.ts's precedent.
    const msg = err instanceof Error ? err.message : String(err);
    await approveApproach(opts.taskId, opts.email, opts.approach).catch(() => {});
    return { gated: true, approved: true, escalated: false, note: `approach gate error, proceeding: ${msg.slice(0, 120)}` };
  }
}
