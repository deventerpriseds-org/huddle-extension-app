// Hardened review gate (docs/plan-wip-confirm-review-gate.md, Part 2): a code MUST, not a prompt
// "should" — a firing trap is signal, and a prose-only review step is skippable by a small model and
// fails SILENTLY (the user has no way to know a review never happened). When a requireStructuredWorkflow
// agent's create_artifact succeeds for a board task, this makes ONE direct, synchronous, structured-
// output call against assignment-reviewer's charter — NOT the async delegate_to_specialist path, which
// would recreate the exact silent-pass-through bug this gate exists to prevent (create_artifact's
// IN_REVIEW write is synchronous; an async worker + later fan-in can't correctly gate a synchronous
// write without introducing a new interim state). Because this is one bounded extra call, the task's
// DOING WIP-cap slot is held only for that call's duration, not indefinitely.
//
// Scope: this gates the ASSIGNED PERSONA's own task-completion artifact (autowork's researchDirective
// drives exactly this path) — not a delegated Pillar-2 worker's own sub-artifact, which is a separate,
// already-reviewed-by-the-persona mechanism (the persona integrates worker findings before it ever
// calls create_artifact on the task itself).

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

export interface ReviewGateResult {
  /** false = requireStructuredWorkflow is OFF for this agent — the gate did not run at all. */
  gated: boolean;
  /** true = go ahead and mark the task IN_REVIEW now. */
  proceed: boolean;
  /** Human-facing summary, for recordToolUse / Terry's verdict narration. */
  note: string;
  deficiencies?: string[];
}

/**
 * Run the gate for one create_artifact save. `claim` should be the turn's existing
 * turnActionLedger.claimAction — keyed on (taskId, revisionCount) here so a second concurrent
 * dispatch in the same group turn can't double-grade or double-increment the revision counter.
 */
export async function runReviewGate(opts: {
  taskId: string;
  agentId: string;
  email: string;
  content: string;
  claim: (key: string) => boolean;
}): Promise<ReviewGateResult> {
  const { isStructuredWorkflowRequired, getWorkflowCaps } = await import("../identity/agent-workflow-config.server");
  const required = await isStructuredWorkflowRequired(opts.email, opts.agentId).catch(() => false);
  if (!required) return { gated: false, proceed: true, note: "" };

  const { getTaskEngagementState, incrementRevisionCount } = await import("./tasks.server");
  const state = await getTaskEngagementState(opts.taskId).catch(() => null);
  const revisionCount = state?.revision_count ?? 0;
  const dod = state?.confirmed_dod?.trim();
  const caps = await getWorkflowCaps(opts.email, opts.agentId).catch(() => ({ approach: 3, review: 3, question: 2 }));

  if (!opts.claim(`review_gate:${opts.taskId}:${revisionCount}`)) {
    // Another dispatch in this same turn already ran (or is running) the grading for this exact
    // revision — don't double-call the reviewer or double-increment the counter.
    return { gated: true, proceed: true, note: "review already in flight this turn" };
  }

  try {
    const { callOpenAIRouter } = await import("../openai-responses.server");
    const reviewer = WORKERS["assignment-reviewer"];
    const verdict = await callOpenAIRouter<{ verdict: "pass" | "revise"; deficiencies: string[] }>({
      model: REVIEWER_MODEL,
      system: reviewer.charter,
      prompt:
        "Grade this deliverable.\n\n" +
        (dod
          ? `Definition of Done it must satisfy:\n${dod}\n\n`
          : "No Definition of Done was confirmed for this task — grade against the team's executive-output standard alone.\n\n") +
        `Deliverable:\n${opts.content.slice(0, 12_000)}`,
      schema: VERDICT_SCHEMA,
      schemaName: "assignment_review_verdict",
    });

    if (verdict.verdict === "pass") {
      return { gated: true, proceed: true, note: "review pass: cleared" };
    }
    if (revisionCount + 1 < caps.review) {
      await incrementRevisionCount(opts.taskId, opts.email).catch(() => {});
      return {
        gated: true,
        proceed: false,
        note: `sent back for revision (${revisionCount + 1}/${caps.review}) — ${verdict.deficiencies.slice(0, 3).join("; ")}`,
        deficiencies: verdict.deficiencies,
      };
    }
    // Cap exhausted and still flagged — fail open (never hold the WIP slot or loop indefinitely).
    // The deficiencies ride along so the user/Terry can see them.
    return {
      gated: true,
      proceed: true,
      note: `review incomplete after ${caps.review} revisions, proceeding — flagged: ${verdict.deficiencies.slice(0, 3).join("; ")}`,
      deficiencies: verdict.deficiencies,
    };
  } catch (err) {
    // The grading call itself errored/timed out — fail open rather than hang the task on a review-gate
    // outage (mirrors the worker fan-in's existing fail-open precedent for an errored worker).
    const msg = err instanceof Error ? err.message : String(err);
    return { gated: true, proceed: true, note: `review gate error, proceeding: ${msg.slice(0, 120)}` };
  }
}
