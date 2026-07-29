// ACT-5 Phase B / B3 — the morning standup digest. Routine autonomous results are tagged `batch` (they
// don't buzz the phone, B1); this once-a-day job SURFACES them: it summarizes what the team did since
// yesterday (documents produced, per agent/lane), what's blocked pending the user, and today's top
// priorities, and delivers ONE proactive message in the coordinator's DM — tagged `notify:"push"`, so it
// is the single daily nudge that stands in for all the per-result buzzes we suppressed. Also delivers the
// standup summary the user was missing (ACT-6). Change-gated (nothing happened → no digest) unless forced.
//
// Rides the ACT-4/ACT-5 scheduler as a `standup-digest` job; reuses the durable-turn → send_push path.

import { AGENT_BY_ID, type AgentId } from "../../data/agents";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface StandupRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  produced?: number; // artifacts delivered since yesterday
  blocked?: number;
  movedToReview?: number; // tasks that entered IN_REVIEW since the last standup run
  runId: string;
}

const COORDINATOR: AgentId = "terry-locke";
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // "since yesterday"
const MAX_BRIEF = 2600; // keep the directive under the 4000-char turn-payload cap (learned bug)

function agentName(id: string | null): string {
  return (id && AGENT_BY_ID[id as AgentId]?.name) || id || "the team";
}

function buildBrief(
  produced: { name: string; agentId: string | null; folder: string }[],
  movedToReview: { title: string; agent: string | null }[],
  blocked: { title: string; reason?: string }[],
  priorities: { title: string; agent: string | null }[],
): string {
  const lines: string[] = [];
  if (produced.length) {
    lines.push(`Work the team completed since yesterday (${produced.length} document(s), for your review):`);
    for (const p of produced.slice(0, 8)) {
      lines.push(`- "${p.name}" by ${agentName(p.agentId)}${p.folder ? ` (${p.folder})` : ""}`);
    }
  }
  if (movedToReview.length) {
    lines.push("", `Moved to "Ready for review" since the last standup (${movedToReview.length}):`);
    for (const t of movedToReview.slice(0, 8)) {
      lines.push(`- "${t.title.slice(0, 120)}"${t.agent ? ` — ${agentName(t.agent)}` : ""}`);
    }
  }
  if (blocked.length) {
    lines.push("", `Blocked pending YOUR input (${blocked.length}) — the team can't proceed without you:`);
    for (const b of blocked.slice(0, 6)) {
      lines.push(`- "${b.title.slice(0, 100)}"${b.reason ? ` — ${b.reason.slice(0, 160)}` : ""}`);
    }
  }
  if (priorities.length) {
    lines.push("", `Today's top priorities:`);
    for (const p of priorities.slice(0, 5)) lines.push(`- "${p.title.slice(0, 120)}"${p.agent ? ` — ${agentName(p.agent)}` : ""}`);
  }
  const brief = lines.join("\n");
  return brief.length > MAX_BRIEF ? `${brief.slice(0, MAX_BRIEF)}\n…(more in the app)` : brief;
}

/** Post the digest as a durable turn in the coordinator's DM and run inline so its push fires now. */
async function surfaceDigest(opts: { email: string; tz: string; caller: Caller; brief: string; runId: string }): Promise<void> {
  const directive =
    `You (Terry Locke, coordinator) are delivering the user's MORNING STANDUP — a proactive daily summary; ` +
    `they did NOT ask just now. Here is what the team did, what's blocked, and today's priorities:\n\n${opts.brief}\n\n` +
    `Write ONE warm, well-organized standup message in your own voice: briefly recap what got done (name who ` +
    `did what), mention anything freshly moved into "ready for review" so they know it's waiting on them, ` +
    `then CLEARLY flag anything blocked pending the user and ask them to weigh in, then the top priorities ` +
    `for today. This is a REPORT-ONLY turn — everything is already saved, so do NOT call any tool and do not ` +
    `paste raw JSON. Keep it skimmable.`;
  const payload = {
    text: directive,
    huddleId: `dm-${COORDINATOR}`,
    scope: "one-to-one",
    members: [COORDINATOR],
    targetAgentId: COORDINATOR,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [COORDINATOR]: { backend: "openai", journey: { enabled: false } } },
    timeZone: opts.tz,
    caller: opts.caller,
    notify: "push", // the standup IS the daily nudge that replaces per-result buzzing
    internal: true, // system-originated digest — never pass along / defer
  };
  const { enqueueTurn } = await import("./turns.server");
  const fresh = await enqueueTurn(`standup-${opts.runId}`, `dm-${COORDINATOR}`, opts.email, payload);
  if (fresh) {
    const { runTurnById } = await import("../huddle.functions");
    await runTurnById(`standup-${opts.runId}`);
  }
}

/**
 * Run one standup-digest pass for a user: summarize the last 24h of the team's produced artifacts, the
 * blocked items needing input, and today's top priorities, and deliver one push digest. A no-op when
 * nothing happened and nothing is blocked (unless forced). Never throws.
 */
export async function runScheduledStandup(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<StandupRunResult> {
  const runId =
    opts.runId?.trim() || `standup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getBoardTasks, getTaskBlockers, getLastStandupAt, setLastStandupAt, getTaskEngagementStatesSince } =
    await import("./tasks.server");
  const { listArtifacts } = await import("../artifacts/artifacts.server");

  const now = Date.now();
  const artifacts = await listArtifacts(email);
  const produced = artifacts
    .filter((a) => {
      const t = Date.parse(a.created_at);
      return Number.isFinite(t) && now - t <= LOOKBACK_MS;
    })
    .map((a) => ({ name: a.name, agentId: a.agent_id, folder: a.folder }));

  const board = await getBoardTasks(email);
  const blockers = await getTaskBlockers(email);
  const notDone = board.filter((t) => !t.completed_at && (t.status ?? "").toUpperCase() !== "DONE");
  // Blocked = tasks an agent flagged (a task_blockers row), shown with the REAL reason it recorded.
  const blocked = notDone
    .filter((t) => blockers.has(t.id))
    .map((t) => ({ title: t.title, reason: blockers.get(t.id)?.reason }));
  const priorities = notDone
    .filter((t) => !blockers.has(t.id))
    .sort((a, b) => (a.priority_rank ?? 9999) - (b.priority_rank ?? 9999))
    .slice(0, 5)
    .map((t) => ({ title: t.title, agent: t.assigned_agent }));

  // Tasks that moved to IN_REVIEW since the last standup actually ran (WIP confirm-intent gate, Part 1)
  // — additive to Iris's separate passive review-digest, which reports the full "waiting now" snapshot.
  const lastStandupAt = await getLastStandupAt(email);
  const since = lastStandupAt ?? new Date(now - LOOKBACK_MS).toISOString();
  const enteredReviewIds = await getTaskEngagementStatesSince(email, since);
  const inReview = board.filter((t) => !t.completed_at && (t.status ?? "").toUpperCase() === "IN_REVIEW");
  const movedToReview = inReview
    .filter((t) => enteredReviewIds.has(t.id))
    .map((t) => ({ title: t.title, agent: t.assigned_agent }));

  if (!produced.length && !blocked.length && !movedToReview.length && !opts.force) {
    return { ok: true, skipped: true, reason: "nothing_to_report", produced: 0, blocked: 0, runId };
  }

  await surfaceDigest({ email, tz, caller, brief: buildBrief(produced, movedToReview, blocked, priorities), runId });
  await setLastStandupAt(email).catch(() => {});
  return { ok: true, skipped: false, produced: produced.length, blocked: blocked.length, movedToReview: movedToReview.length, runId };
}
