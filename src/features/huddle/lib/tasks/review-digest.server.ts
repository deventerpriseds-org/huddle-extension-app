// Per-agent WIP-limited flow's user-facing half: a gentle digest of what's sitting in IN_REVIEW,
// waiting on the user's approval before it can become DONE. Fires on a fixed 5x/day cadence
// (8am/11am/1pm/4pm/7pm local) via the same scheduled_jobs/heartbeat mechanism as grooming/auto-work/
// standup — see scheduler.server.ts. Delivered by Iris Chase (team lead) as ONE proactive chat message
// in her own DM; a no-op when nothing is waiting (no empty pings). Never sets status itself — this is
// report-only, mirroring standup.server.ts.

import { AGENT_BY_ID, type AgentId } from "../../data/agents";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface ReviewDigestRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  waiting?: number; // tasks in IN_REVIEW across all agents
  runId: string;
}

const TEAM_LEAD: AgentId = "iris-chase";
const MAX_BRIEF = 2600; // keep the directive under the 4000-char turn-payload cap (learned bug)

function agentName(id: string | null): string {
  return (id && AGENT_BY_ID[id as AgentId]?.name) || id || "the team";
}

function buildBrief(byAgent: Map<string, { title: string }[]>): string {
  const lines: string[] = [`Waiting on your review right now:`];
  for (const [agentId, tasks] of byAgent) {
    lines.push(`- ${agentName(agentId)} (${tasks.length}):`);
    for (const t of tasks.slice(0, 4)) lines.push(`  - "${t.title.slice(0, 100)}"`);
  }
  const brief = lines.join("\n");
  return brief.length > MAX_BRIEF ? `${brief.slice(0, MAX_BRIEF)}\n…(more in the app)` : brief;
}

/** Post the digest as a durable turn in Iris's own DM and run inline so its push fires now. */
async function surfaceDigest(opts: { email: string; tz: string; caller: Caller; brief: string; waiting: number; runId: string }): Promise<void> {
  const directive =
    `You (Iris Chase, team lead) are giving the user a GENTLE nudge — they did NOT ask just now. ${opts.waiting} ` +
    `item${opts.waiting === 1 ? " is" : "s are"} sitting in "Ready for review" waiting on THEIR approval before ` +
    `it can move to Done:\n\n${opts.brief}\n\n` +
    `Write ONE short, warm message: mention what's waiting and by whom, and invite them to take a look and ` +
    `approve/clear what looks good whenever they get a chance — no pressure, this is just a heads-up. This is a ` +
    `REPORT-ONLY turn: do not call any tool, and do not paste raw data. Keep it brief and skimmable.`;
  const payload = {
    text: directive,
    huddleId: `dm-${TEAM_LEAD}`,
    scope: "one-to-one",
    members: [TEAM_LEAD],
    targetAgentId: TEAM_LEAD,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [TEAM_LEAD]: { backend: "openai", journey: { enabled: false } } },
    timeZone: opts.tz,
    caller: opts.caller,
    notify: "push", // the whole point is a gentle proactive nudge
    internal: true, // system-originated digest — never pass along / defer
  };
  const { enqueueTurn } = await import("./turns.server");
  const fresh = await enqueueTurn(`review-digest-${opts.runId}`, `dm-${TEAM_LEAD}`, opts.email, payload);
  if (fresh) {
    const { runTurnById } = await import("../huddle.functions");
    await runTurnById(`review-digest-${opts.runId}`);
  }
}

/**
 * Run one review-digest pass for a user: collect every task currently IN_REVIEW, grouped by agent, and
 * have Iris deliver one gentle nudge. A no-op when nothing is waiting (unless forced). Never throws.
 */
export async function runScheduledReviewDigest(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<ReviewDigestRunResult> {
  const runId =
    opts.runId?.trim() || `review-digest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getBoardTasks } = await import("./tasks.server");
  const board = await getBoardTasks(email);
  const inReview = board.filter((t) => !t.completed_at && (t.status ?? "").toUpperCase() === "IN_REVIEW");

  if (!inReview.length && !opts.force) {
    return { ok: true, skipped: true, reason: "nothing_waiting", waiting: 0, runId };
  }

  const byAgent = new Map<string, { title: string }[]>();
  for (const t of inReview) {
    const agent = t.assigned_agent ?? "unassigned";
    const list = byAgent.get(agent) ?? [];
    list.push({ title: t.title });
    byAgent.set(agent, list);
  }

  await surfaceDigest({ email, tz, caller, brief: buildBrief(byAgent), waiting: inReview.length, runId });
  return { ok: true, skipped: false, waiting: inReview.length, runId };
}
