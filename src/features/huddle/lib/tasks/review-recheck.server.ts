// The 48h post-review recheck (docs/plan-wip-confirm-review-gate.md, Part 1). Iris's review-digest
// (review-digest.server.ts) already reports the full "what's waiting right now" snapshot 5x/day, team-
// wide. This is deliberately DIFFERENT: per IN_REVIEW task, the ASSIGNED agent itself — not the team
// lead — reaches out ad hoc, roughly every 48h, to ask specifically about ITS OWN work: approved, or
// corrections needed. A real teammate checking on their own deliverable, not a passive digest.
//
// next_review_ping_at is seeded once when a task enters IN_REVIEW (huddle.functions.ts, alongside
// markEnteredReview) and rescheduled another ~48h out each time this fires — same non-bursty, jittered
// delivery as the confirm-intent ask.

import { AGENT_BY_ID, type AgentId } from "../../data/agents";
import type { BoardTaskRow } from "./tasks.server";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface ReviewRecheckRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  pinged?: number;
  runId: string;
}

const REVIEW_PING_BASE_MS = 48 * 60 * 60_000;
const REVIEW_PING_JITTER_MS = 2 * 60 * 60_000;
const RECHECK_MAX = 8; // keep the per-pass fan-out small, like autowork's AUTOWORK_MAX

function reviewRecheckDirective(task: { title: string }): string {
  return (
    `A while back you moved this task to the user's review queue: "${task.title}". Check in with them, ` +
    `briefly and warmly, about it: have they had a chance to look, and if so was it approved, or is ` +
    `something missing or in need of correction? Keep it to one short, natural message — this is a light ` +
    `check-in, not a status report. Do not call any tool.`
  );
}

function turnPayload(agent: string, directive: string, tz: string, caller: Caller) {
  return {
    text: directive,
    huddleId: `dm-${agent}`,
    scope: "one-to-one",
    members: [agent],
    targetAgentId: agent,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [agent]: { backend: "openai", journey: { enabled: false } } },
    timeZone: tz,
    caller,
    notify: "push", // an ad hoc personal check-in — not a routine result, so it does buzz the phone
    internal: true, // system-originated — no pass-along/deferral machinery
  };
}

/**
 * Run one 48h-recheck pass for a user: for every IN_REVIEW task whose next_review_ping_at has passed,
 * have the ASSIGNED agent send one ad hoc check-in DM and reschedule another ~48h out (jittered so
 * several simultaneously-due tasks don't all fire in the same instant). A no-op when nothing is due.
 * Never throws.
 */
export async function runScheduledReviewRecheck(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<ReviewRecheckRunResult> {
  const runId =
    opts.runId?.trim() || `review-recheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getBoardTasks, getTaskEngagementStates, ensureNextReviewPing, rescheduleNextReviewPing } = await import(
    "./tasks.server"
  );
  const { enqueueTurn } = await import("./turns.server");

  const board = await getBoardTasks(email);
  const inReview = board.filter(
    (t): t is BoardTaskRow & { assigned_agent: string } =>
      !t.completed_at && (t.status ?? "").toUpperCase() === "IN_REVIEW" && !!t.assigned_agent && !!AGENT_BY_ID[t.assigned_agent as AgentId],
  );

  if (!inReview.length && !opts.force) {
    return { ok: true, skipped: true, reason: "nothing_in_review", pinged: 0, runId };
  }

  const states = await getTaskEngagementStates(inReview.map((t) => t.id));
  const now = Date.now();
  const due: BoardTaskRow[] = [];
  const needsSeed: BoardTaskRow[] = [];
  for (const t of inReview) {
    const nextPing = states.get(t.id)?.next_review_ping_at;
    if (!nextPing) {
      needsSeed.push(t); // entered review before this shipped (or the seed write failed) — backstop
    } else if (new Date(nextPing).getTime() <= now) {
      due.push(t);
    }
  }

  const jitteredIso = () => new Date(now + REVIEW_PING_BASE_MS + Math.random() * REVIEW_PING_JITTER_MS).toISOString();

  if (needsSeed.length) {
    await Promise.all(needsSeed.map((t) => ensureNextReviewPing(t.id, email, jitteredIso()).catch(() => {})));
  }

  let pinged = 0;
  for (const task of due.slice(0, RECHECK_MAX)) {
    try {
      const agent = task.assigned_agent as string;
      const id = `review-recheck-${runId}-${task.id}`;
      await enqueueTurn(id, `dm-${agent}`, email, turnPayload(agent, reviewRecheckDirective(task), tz, caller));
      await rescheduleNextReviewPing(task.id, jitteredIso());
      pinged++;
    } catch {
      /* enqueue/reschedule failure is non-fatal — next_review_ping_at stays past-due and retries next pass */
    }
  }

  return { ok: true, skipped: false, pinged, runId };
}
