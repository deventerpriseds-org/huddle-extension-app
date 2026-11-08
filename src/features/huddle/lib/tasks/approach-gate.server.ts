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
import { mayRegradeEscalated } from "./approach-override";

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

/**
 * TUNED 2026-11-05 (owner: "the autograder never passes... everything is pushed back to me. it needs to be
 * tuned"). Measured: the test task 883bc5dc was graded revise three times in one turn and escalated, and the
 * real tasks 3147559c, 7b1cb9f8 and 9e4c395d all escalated at the cap. ROOT CAUSE: this gate graded a PLAN
 * with WORKERS["assignment-reviewer"], the charter written for a FINISHED deliverable ("grounded in
 * evidence… decision-ready… do not rubber-stamp") — a bar a plan written before any research can never
 * meet — and the model chose pass/revise freely, so any nitpick failed it.
 *
 * NOW: a plan-specific charter, and the model only LISTS problems, split into `blocking` and `suggestions`.
 * The verdict is decided HERE, in code: pass iff nothing is blocking. Suggestions ride back to the agent on
 * a pass so they improve the work instead of stalling it. The finished-deliverable charter is untouched and
 * still used by the review gate (review-gate.server.ts).
 */
export const APPROACH_REVIEWER_CHARTER =
  "You review an agent's PLANNED APPROACH for a task, before any work has started. It is a plan, not a " +
  "deliverable: it will not contain findings, evidence or final answers yet, and that is never a problem. " +
  "Your only question: if the agent follows this plan, will it realistically reach the Definition of Done " +
  "the user confirmed? A problem is BLOCKING only if it would make the plan fail that — it misses a part of " +
  "the Definition of Done, works on the wrong thing, ignores a constraint the user stated (budget, location, " +
  "scope), or depends on access or information the agent cannot get. Everything else — more depth, extra " +
  "sources, better structure, wording, nice-to-haves — is a SUGGESTION, never blocking. Most reasonable " +
  "plans have zero blocking problems. Be specific and brief.";

const APPROACH_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    blocking: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["blocking", "suggestions"],
  additionalProperties: false,
} as const;

/** The verdict rule, in code: a plan passes iff the reviewer found nothing BLOCKING. Exported for the test. */
export function approachVerdict(raw: { blocking?: unknown; suggestions?: unknown } | null | undefined): {
  verdict: "pass" | "revise";
  deficiencies: string[];
  suggestions: string[];
} {
  // A plain string is ONE item (VERIFY-wip-e2e-pickup-fit-1 C7: `blocking: "ignores the budget"` used to pass).
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0);
  const blocking = list(raw?.blocking);
  return { verdict: blocking.length ? "revise" : "pass", deficiencies: blocking, suggestions: list(raw?.suggestions) };
}

/**
 * DID THE OWNER AUTHORISE PROCEEDING ON THIS TASK? — the verdict the turn-pair override rests on.
 *
 * This is the SAME grading path `runApproachGate` uses below (`callOpenAIRouter`, the same reviewer
 * model, the same structured-output contract), asked a different question. It is here rather than in
 * a module of its own on purpose: a second grader is a second thing to keep calibrated, and this file
 * is already where "the gate asks a model to judge something" lives.
 *
 * WHAT IT IS HANDED, and why this is not the refuted classifier: both texts are read by the SERVER out
 * of `chat.pending_turns` after the caller names a turn (.claude/BUILD-override-turn-pair.md). The
 * agent's own escalation notice is in the prompt, so "go ahead" is judged AS A REPLY TO A KNOWN
 * QUESTION rather than as an isolated fragment. Every attack that broke `verifyOwnerQuote` was an
 * isolated fragment: an unrelated go-ahead, a pasted proposal, a postponement, a two-topic message.
 *
 * FAILS CLOSED. A throw propagates; there is no verdict-shaped fallback, because a grader outage that
 * silently authorised an override would be indistinguishable to the owner from one he granted.
 */
export async function gradeOverrideAuthorisation(opts: {
  taskTitle: string;
  /** The escalation notice the owner was replying to — server-fetched, anchored to this task. */
  agentText: string;
  /** The owner's own reply — server-fetched from HIS turn. */
  ownerText: string;
}): Promise<{ authorised: boolean; reason: string }> {
  const { callOpenAIRouter } = await import("../openai-responses.server");
  const reviewer = WORKERS["assignment-reviewer"];
  const verdict = await callOpenAIRouter<{ authorised: boolean; reason: string }>({
    model: REVIEWER_MODEL,
    system: reviewer.charter,
    prompt:
      "You are deciding ONE question about a two-message exchange, and nothing else. An automated " +
      "quality gate blocked a task; an agent told the user it was blocked; the user replied. Did the " +
      "USER, in that reply, authorise this specific task going ahead anyway despite the gate?\n\n" +
      "Answer true ONLY if the reply is an affirmative instruction to proceed on THIS task. Answer " +
      "false for anything else, and these are the cases that matter most:\n" +
      "- a refusal, a hedge, a doubt, or a condition attached (\"not until...\", \"never approve that\")\n" +
      "- a POSTPONEMENT (\"not now\", \"later\", \"remind me tomorrow\")\n" +
      "- the user quoting, forwarding or restating somebody else's words or the agent's own proposal " +
      "without adopting it as their own instruction\n" +
      "- a go-ahead that is plainly about something ELSE (another task, an errand, a different topic " +
      "mentioned in the same message)\n" +
      "- a question, an acknowledgement (\"ok\", \"got it\", \"thanks\") or a comment with no instruction\n" +
      "If you are unsure, answer false. A wrong true lets work proceed that the user never approved.\n\n" +
      `The blocked task: ${opts.taskTitle}\n\n` +
      `What the agent told the user:\n${opts.agentText.slice(0, 3000)}\n\n` +
      `What the user replied:\n${opts.ownerText.slice(0, 3000)}`,
    schema: {
      type: "object",
      properties: {
        authorised: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["authorised", "reason"],
      additionalProperties: false,
    },
    schemaName: "override_authorisation_verdict",
  });
  return { authorised: verdict.authorised === true, reason: String(verdict.reason ?? "") };
}

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
/**
 * Run one auto-work pass for this user right after an approach is approved, so a confirmed + approved task
 * moves to Doing and its work turn is enqueued immediately. Bounded (8s) and never throws: the approval is
 * already saved, and the scheduled 9/13/17 pass remains the fallback if this one is slow or fails.
 * `run` is injectable for the offline test.
 */
export async function kickAutoWorkAfterApproval(
  email: string,
  run: () => Promise<unknown> = async () =>
    (await import("./autowork.server")).runScheduledAutoWork({ entra_email: email }, { force: true }),
): Promise<boolean> {
  try {
    const done = await Promise.race([run().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8_000))]);
    return done;
  } catch {
    return false;
  }
}

export async function runApproachGate(opts: {
  taskId: string;
  agentId: string;
  email: string;
  taskTitle: string;
  approach: string;
  claim: (key: string) => boolean;
}): Promise<ApproachGateResult> {
  const { isStructuredWorkflowRequired, getWorkflowCaps } = await import("../identity/agent-workflow-config.server");
  // FAILS CLOSED (CLAUDE.md: the confirm-intent/DoD gate "MUST fail CLOSED"). A settings-read error used to
  // read as "gate off" and approve the plan unseen (VERIFY-wip-e2e-pickup-fit-2, found outside the claims).
  const required = await isStructuredWorkflowRequired(opts.email, opts.agentId).catch(() => true);
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

  const revisionCount = state?.approach_revision_count ?? 0;
  const caps = await getWorkflowCaps(opts.email, opts.agentId).catch(() => ({ approach: 3, review: 3, question: 2 }));

  // (B) AN ESCALATED TASK IS NO LONGER A DEAD END. This used to return here without grading anything,
  // which made 'escalated' terminal: the owner could supply exactly the missing input the gate asked
  // for and the next propose_approach was still refused unread. Cole Blake, live: "the workflow remains
  // locked in its prior escalated state and is rejecting further approach submissions... the task needs
  // to be reset before I can execute it." There was no reset the owner could reach.
  //
  // The short-circuit WAS the loop bound, though, so removing it needs a replacement, and the
  // replacement reuses the counter that already exists rather than adding a column: a re-grade attempt
  // is COUNTED BEFORE IT IS GRADED (below), and once approach_revision_count reaches
  // regradeCeiling(cap) the gate stops spending grader calls and says so. Past that point the only way
  // forward is a recorded owner override (overrideApproachGate) — which is now a thing the owner has.
  const wasEscalated = state?.approach_status === "escalated";
  if (wasEscalated && !mayRegradeEscalated(revisionCount, caps.approach)) {
    return {
      gated: true,
      approved: false,
      escalated: true,
      note:
        "still escalated, and the re-grade limit is reached — don't submit another approach. Tell the " +
        "user plainly what you're blocked on; they can approve it as-is with the Approve anyway button.",
    };
  }

  if (!opts.claim(`approach_gate:${opts.taskId}:${revisionCount}`)) {
    return { gated: true, approved: false, escalated: false, note: "approach review already in flight this turn" };
  }

  try {
    // Count the attempt BEFORE grading, so a grader that errors or times out still consumes one and a
    // failing re-grade loop cannot run forever. Only on the escalated path: the normal path's counter
    // is driven by the `revise` verdict below and must keep its existing meaning.
    if (wasEscalated) await incrementApproachRevisionCount(opts.taskId, opts.email).catch(() => {});
    const { callOpenAIRouter } = await import("../openai-responses.server");
    const dod = state?.confirmed_dod?.trim();
    // Keep the latest submitted plan on the row whatever the outcome, so an escalation can be inspected.
    const { recordProposedApproach } = await import("./tasks.server");
    await recordProposedApproach(opts.taskId, opts.email, opts.approach).catch(() => {});
    const verdict = approachVerdict(
      await callOpenAIRouter<{ blocking: string[]; suggestions: string[] }>({
        model: REVIEWER_MODEL,
        system: APPROACH_REVIEWER_CHARTER,
        prompt:
          `Task: ${opts.taskTitle}\n\n` +
          (dod
            ? `Definition of Done the user confirmed:\n${dod}\n\n`
            : "No Definition of Done was confirmed for this task — judge the plan's fit to the task alone.\n\n") +
          `Planned approach:\n${opts.approach.slice(0, 4000)}\n\n` +
          "List BLOCKING problems (would make the plan fail the Definition of Done) and SUGGESTIONS " +
          "(everything else). Empty blocking is the expected answer for a reasonable plan.",
        schema: APPROACH_VERDICT_SCHEMA,
        schemaName: "approach_plan_review",
      }),
    );
    const foldIn = verdict.suggestions.length
      ? ` Fold these suggestions into the work (they do not block it): ${verdict.suggestions.slice(0, 4).join("; ")}.`
      : "";

    if (verdict.verdict === "pass") {
      await approveApproach(opts.taskId, opts.email, opts.approach).catch(() => {});
      // Start the work NOW, not at the next 9/13/17 auto-work pass. Owner 2026-11-05, after a confirmed +
      // approved task sat in Up Next: "why would you as an agent follow my schedule instead of starting
      // things as soon as they are confirmed?"
      // F3 (docs/qc-evidence/BUILD-handoff-lane-b.md, AC-F3-2): a LIVE-confirmed task is moved straight to
      // Doing first (owner Option A: past the one-at-a-time cap). It is a no-op without the server-written
      // live marker, so background-confirmed tasks fall through to the general kick, unchanged.
      let liveStarted = false;
      try {
        const { advanceLiveConfirmedTask } = await import("./autowork.server");
        const r = await Promise.race([
          advanceLiveConfirmedTask({ taskId: opts.taskId, email: opts.email }),
          new Promise<{ started: boolean }>((res) => setTimeout(() => res({ started: false }), 8_000)),
        ]);
        liveStarted = r.started === true;
      } catch {
        liveStarted = false;
      }
      const kicked = liveStarted || (await kickAutoWorkAfterApproval(opts.email));
      return {
        gated: true,
        approved: true,
        escalated: false,
        note:
          (wasEscalated ? "re-graded after escalation — approach approved" : "approach approved") +
          (liveStarted
            ? ". The work has started now: it is in Doing."
            : kicked
            ? ". The work is being started now: it moves to Doing immediately unless you already have a task in " +
              "Doing (one at a time), in which case it is next."
            : ". Starting it right now didn't go through, so the next automatic pass (within a few hours) starts " +
              "it — nothing else is needed from the user.") +
          " Tell the user exactly that — never that they need to authorize the start or that it waits for a " +
          "calendar block." +
          foldIn,
      };
    }
    // A failed RE-grade goes straight back to escalated rather than into the revise loop. The task is
    // already in the owner's court and they have been told about it; quietly taking it back out of
    // their court is how a stuck task becomes invisible again. They get the fresh deficiencies instead.
    if (wasEscalated) {
      await escalateApproach(opts.taskId, opts.email).catch(() => {});
      return {
        gated: true,
        approved: false,
        escalated: true,
        note: `re-graded and still not sound — ${verdict.deficiencies.slice(0, 3).join("; ")}`,
        deficiencies: verdict.deficiencies,
      };
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
    const msg = err instanceof Error ? err.message : String(err);
    // A RE-grade that errors leaves the task escalated. The fail-open below is a deliberate, long-
    // standing property of this gate for a FRESH approach (don't block a task on a gate outage), but
    // extending it here would make a grader outage a silent escape from a state the owner has already
    // been told about — and the owner would never learn the difference, because an overridden-looking
    // 'approved' row is exactly what they would see. Escalated it stays; the override is the way out.
    if (wasEscalated) {
      return {
        gated: true,
        approved: false,
        escalated: true,
        note: `re-grade couldn't run (${msg.slice(0, 100)}) — still escalated, so raise it with the user`,
      };
    }
    // The grading call itself errored/timed out — FAIL OPEN IN THE RETURN, NEVER IN THE STORED STATE.
    // This used to `await approveApproach(...)` here, which permanently recorded an approval no grader
    // ever produced: one transient OpenAI 429 (a recurring event in this repo — see CLAUDE.md's
    // "fail fast on quota") marked a task approved forever, indistinguishable from a real pass, and
    // `autowork.server.ts` would then auto-promote it to DOING on every later pass. The sibling review
    // gate has the correct shape and always did (review-gate.server.ts:104-109): it returns
    // `proceed:true` and writes nothing. So this turn proceeds — the task is not blocked on a gate
    // outage — but the gate's own record still says "not approved", so the next pass grades it for
    // real once the grader is back. A degraded moment must not become a permanent verdict.
    return { gated: true, approved: true, escalated: false, note: `approach gate error, proceeding: ${msg.slice(0, 120)}` };
  }
}
