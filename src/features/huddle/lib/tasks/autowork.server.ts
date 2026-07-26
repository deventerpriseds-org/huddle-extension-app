// ACT-5 gate 1 — agent auto-work (research), done GENUINELY BY THE AGENTS. On a cadence (the same
// every-minute scheduler that drives grooming/reminders), for each of a user's OPEN, ASSIGNED,
// non-blocked tasks that isn't already backed by an artifact, this engine ENQUEUES a real durable turn
// for the ASSIGNED AGENT in its own DM. The heartbeat's drainQueuedTurns then runs that turn: the agent's
// own LLM plans the research, calls the web-search tool itself, synthesizes findings in its lane voice,
// saves the full write-up via the create_artifact tool, and replies in its DM — which rides the existing
// send_push notification. The engine does NOT do the research or write the artifact itself (that would be
// a mechanical stand-in wearing the agent's name — see memory.md hardening 2026-07-26); it only decides
// WHICH agent researches WHAT, and lets the agent actually do it.
//
// Honest failure mode: if an agent's turn fails (LLM quota/timeout), no artifact is produced, the task
// stays a candidate, and it is retried on the next pass (fresh turn id per run). Nothing is faked.

import { backlogSignature } from "./grooming.server";
import { AGENT_BY_ID, type AgentId } from "../../data/agents";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface AutoWorkRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  enqueued?: number; // agent research turns enqueued this pass
  blocked?: number; // grooming-flagged blocked items surfaced
  remaining?: number; // candidates left for the next fire
  runId: string;
}

// Each candidate becomes a real agent turn (LLM + web search) that the heartbeat drains one-at-a-time and
// that fires its own push on completion — so keep the per-pass fan-out small; the rest rotates in next fire.
const AUTOWORK_MAX = 4;
const COORDINATOR: AgentId = "terry-locke"; // surfaces blocked items (the research itself is per-agent)

function agentRole(id: string | null): string {
  return (id && AGENT_BY_ID[id as AgentId]?.role) || "specialist";
}

/** The directive the assigned agent runs: research the task for real, save an artifact, report back. */
function researchDirective(task: { id: string; title: string; category: string | null; assigned_agent: string | null }): string {
  const folder = task.category || "Research";
  return (
    `You've been assigned this task on the board: "${task.title}". Do the work now, as the ` +
    `${agentRole(task.assigned_agent)} you are. Research it properly: use your web-search tool to gather ` +
    `current, credible information — plan your searches, prioritize authoritative and leading sources in ` +
    `this area, and think it through. Then:\n` +
    `1) Call create_artifact to SAVE your full findings as a document — detailed markdown with your ` +
    `analysis, the sources you used, and a clear recommendation or concrete next steps. Set task_id to ` +
    `"${task.id}" and folder to "${folder}".\n` +
    `2) In your reply, give the user a substantive summary of what you found and your recommendation — ` +
    `enough detail to be useful on its own, not just "see the doc".\n` +
    `If the task genuinely needs a decision from the user, or you're blocked without their input, say so ` +
    `clearly and ask the specific question instead of guessing. Do NOT create tasks or send email — just ` +
    `research, save the artifact, and report.`
  );
}

function turnPayload(task: { assigned_agent: string | null }, directive: string, tz: string, caller: Caller) {
  const agent = task.assigned_agent as string;
  return {
    text: directive,
    huddleId: `dm-${agent}`,
    scope: "one-to-one",
    members: [agent],
    targetAgentId: agent,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: {
      [agent]: {
        backend: "openai",
        journey: { enabled: false },
        webSearch: true, // ensure the agent is handed its web-search tool
        rag: { store: "azure", chunks: true, triples: false, fileSearch: false, sharing: "shared" },
      },
    },
    timeZone: tz,
    caller,
    // Triage: a routine research result should NOT buzz the phone — it lands in-app and rolls into the
    // standup digest. Only genuine blockers/decisions push (see surfaceBlocked).
    notify: "batch",
  };
}

/** Surface grooming-flagged blocked items in the coordinator's DM (report-only). One short turn. */
async function surfaceBlocked(opts: { email: string; tz: string; caller: Caller; titles: string[]; runId: string }): Promise<void> {
  const list = opts.titles.slice(0, 8).map((t) => `- ${t.slice(0, 120)}`).join("\n");
  const directive =
    `Some of the user's assigned tasks are blocked pending THEIR input — the team can't proceed without a ` +
    `decision or missing capability. Warmly and briefly let the user know these are waiting on them and ask ` +
    `them to weigh in:\n${list}\n\nThis is a REPORT-ONLY turn: do not call any tool, and keep it short.`;
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
    // Blocked items need the user's input → this one DOES buzz the phone.
    notify: "push",
  };
  const { enqueueTurn } = await import("./turns.server");
  await enqueueTurn(`autowork-blocked-${opts.runId}`, `dm-${COORDINATOR}`, opts.email, payload);
}

/**
 * Run one auto-work pass for a user: pick open, assigned, non-blocked tasks that don't yet have an
 * artifact, and ENQUEUE a real research turn for each assigned agent (the agent does the actual work when
 * the heartbeat drains it). Surfaces grooming's blocked items. Bounded per pass, idempotent (a task with
 * an artifact is skipped, so the backlog rotates across fires), a no-op when nothing's new. Never throws.
 */
export async function runScheduledAutoWork(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<AutoWorkRunResult> {
  const runId =
    opts.runId?.trim() || `autowork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getOpenAssignedTasks, getBoardTasks, setAutoWorkSignature } = await import("./tasks.server");
  const { listArtifacts } = await import("../artifacts/artifacts.server");
  const { enqueueTurn } = await import("./turns.server");

  const assigned = await getOpenAssignedTasks(email);
  const signature = backlogSignature(assigned);

  // Idempotency + rotation: a task already backed by an artifact is "done" — skip it. One artifact read.
  const existing = await listArtifacts(email);
  const withArtifact = new Set(existing.map((a) => a.task_id).filter(Boolean) as string[]);
  const candidates = assigned.filter((t) => t.assigned_agent && AGENT_BY_ID[t.assigned_agent as AgentId] && !withArtifact.has(t.id));

  const board = await getBoardTasks(email);
  const blockedTitles = board
    .filter((t) => !t.completed_at && (t.tags ?? []).includes("blocked-on-capability"))
    .map((t) => t.title);

  if (!candidates.length && !opts.force) {
    await setAutoWorkSignature(email, signature);
    return { ok: true, skipped: true, reason: assigned.length ? "nothing_new" : "empty", enqueued: 0, blocked: blockedTitles.length, remaining: 0, runId };
  }

  const batch = candidates.slice(0, AUTOWORK_MAX);
  let enqueued = 0;
  for (const task of batch) {
    // Fresh turn id per run so a failed prior attempt retries; within a pass each task is unique.
    const id = `autowork-${runId}-${task.id}`;
    try {
      await enqueueTurn(id, `dm-${task.assigned_agent}`, email, turnPayload(task, researchDirective(task), tz, caller));
      enqueued++;
    } catch {
      /* enqueue failure is non-fatal — the task stays a candidate and is retried next pass */
    }
  }

  if (blockedTitles.length) {
    try {
      await surfaceBlocked({ email, tz, caller, titles: blockedTitles, runId });
    } catch {
      /* non-fatal */
    }
  }

  await setAutoWorkSignature(email, signature);
  const remaining = Math.max(0, candidates.length - enqueued);
  return { ok: true, skipped: false, enqueued, blocked: blockedTitles.length, remaining, runId };
}
