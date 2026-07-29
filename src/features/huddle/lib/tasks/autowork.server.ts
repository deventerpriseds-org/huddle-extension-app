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
// Per-agent WIP-limited flow (each agent's OWN lane, independently gated):
//   BACKLOG -> UP_NEXT (cap 3) -> DOING (cap 1) -> IN_REVIEW (cap 2) -> DONE
// DONE is NEVER written by this engine (or any automation) — only the user sets it, by hand, in the
// board UI. IN_REVIEW is written elsewhere (create_artifact's dispatch in huddle.functions.ts) the
// instant an agent's DOING turn actually concludes — this file only decides what to PROMOTE/PULL.
// When an agent already has REVIEW_CAP tasks sitting in IN_REVIEW, this engine freezes ALL further
// intake for that agent (no BACKLOG->UP_NEXT, no UP_NEXT->DOING) until the user clears one via the
// board — an already-running DOING turn is left to finish (it isn't aborted mid-flight), so review can
// transiently sit at REVIEW_CAP+1 for a moment, but no NEW work starts until the user makes room.
//
// Honest failure mode: if an agent's turn fails (LLM quota/timeout), no artifact is produced, the task
// stays a candidate, and it is retried on the next pass (fresh turn id per run). Nothing is faked.

import { backlogSignature } from "./grooming.server";
import { AGENT_BY_ID, type AgentId } from "../../data/agents";
import type { BoardTaskRow } from "./tasks.server";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface AutoWorkRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  enqueued?: number; // agent research turns enqueued this pass
  promoted?: number; // BACKLOG->UP_NEXT / UP_NEXT->DOING status writes this pass
  blocked?: number; // grooming-flagged blocked items surfaced
  remaining?: number; // candidates left for the next fire
  confirmAsked?: number; // confirm-intent DMs sent this pass (WIP confirm-intent gate)
  runId: string;
}

// Each candidate becomes a real agent turn (LLM + web search) that the heartbeat drains one-at-a-time and
// that fires its own push on completion — so keep the per-pass fan-out small; the rest rotates in next fire.
// DOING_CAP already limits this to ~1 per agent, so AUTOWORK_MAX is just an overall safety valve.
const AUTOWORK_MAX = 8;
const UP_NEXT_CAP = 3; // "2-3 items" staged per agent
const DOING_CAP = 1; // one at a time, per agent
const REVIEW_CAP = 2; // no more than 2 waiting for the user's review, per agent
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
    `1) You MUST call create_artifact to SAVE your full findings as a document — detailed markdown with ` +
    `your analysis, the sources you used, and a clear recommendation or concrete next steps. Set task_id ` +
    `to "${task.id}" and folder to "${folder}". The app turns that saved document into a clickable link on ` +
    `your message automatically — do NOT write your own link to it, do NOT paste an external website URL as ` +
    `if it were your document, and do NOT claim you "compiled a document" unless this create_artifact call ` +
    `actually succeeded. If for some reason you cannot save it, say so plainly and give the findings inline ` +
    `instead of inventing a link.\n` +
    `2) In your reply, give the user a substantive summary of what you found and your recommendation — ` +
    `enough detail to be useful on its own, not just "see the doc" — and frame the recommendation against ` +
    `the user's stated goals, making the tie explicit (its impact on their revenue, brand/thought-leadership, ` +
    `or career).\n` +
    `Almost always you CAN make progress by researching/drafting — do that. Only if you genuinely cannot ` +
    `advance this task on your own (it truly needs the user's decision, a credential, or a real-world/` +
    `capability the team lacks), call flag_blocker with task_id "${task.id}" and the SPECIFIC reason you ` +
    `need from them — do not guess "blocked" just because they must ultimately finish it. Do NOT create ` +
    `tasks or send email — research, save the artifact (or flag the real blocker), and report.`
  );
}

function turnPayload(
  task: { assigned_agent: string | null },
  directive: string,
  tz: string,
  caller: Caller,
  notify: "batch" | "push" = "batch",
) {
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
    // standup digest. Only genuine blockers/decisions (and the confirm-intent ask) push.
    notify,
    // System-originated: the assigned agent should DO the research, not defer/pass it along (the
    // directive text would otherwise trip the 1:1 lane-handoff → follow-up barrage).
    internal: true,
  };
}

// Confirm-intent gate jitter (docs/plan-wip-confirm-review-gate.md, Part 1): a fresh UP_NEXT candidate
// gets a ONE-TIME random delay before its confirm-intent ask fires, so multiple agents' fresh items
// don't all message the user in the same autowork pass. autowork itself only checks 3x/day (9/13/17
// local, see scheduler.server.ts DEFAULT_AUTOWORK_HOURS) — that cadence is already confined to
// reasonable hours, so no separate "working hours" calculation is needed here: whichever check first
// lands after the jittered instant is when the ask actually fires.
const CONFIRM_JITTER_MIN_MS = 15 * 60_000;
const CONFIRM_JITTER_MAX_MS = 4 * 60 * 60_000;

/** The directive the assigned agent runs to confirm intent + propose a Definition of Done. */
function confirmIntentDirective(task: { id: string; title: string; assigned_agent: string | null }): string {
  return (
    `This task was just staged for you on the board: "${task.title}". Before starting the work, ` +
    `confirm with the user what they actually want to achieve here — ground your understanding in ` +
    `their Executive Profile and anything you remember about their goals (already in your context). ` +
    `In ONE natural, brief message (not an interrogation): say what you believe they're trying to ` +
    `accomplish with this task, propose a concrete, testable Definition of Done, and ask them to ` +
    `confirm it, add to it, or correct it.\n` +
    `Once you understand their reply (confirmed as-is, or with their additions/corrections folded in), ` +
    `call confirm_task_intent with task_id "${task.id}" and the final definition_of_done text — this ` +
    `locks it in and is what moves the task into active work. Do NOT call confirm_task_intent before ` +
    `they've actually replied; this first message is only the ask. Do not create tasks or send email.`
  );
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
    internal: true, // system-originated directive — no pass-along/deferral machinery
  };
  const { enqueueTurn } = await import("./turns.server");
  await enqueueTurn(`autowork-blocked-${opts.runId}`, `dm-${COORDINATOR}`, opts.email, payload);
}

interface AgentBucket {
  backlog: BoardTaskRow[]; // not yet staged (BACKLOG/TODO/PLANNING/READY/null)
  upNext: BoardTaskRow[];
  doing: BoardTaskRow[];
  inReview: BoardTaskRow[];
}

/**
 * Run one auto-work pass for a user: per assigned agent, top up UP_NEXT (cap 3) from BACKLOG, promote
 * one UP_NEXT item to DOING if the agent has none in flight (cap 1), and ENQUEUE that agent's real
 * research turn — unless the agent already has REVIEW_CAP tasks awaiting the user's review, in which
 * case intake is frozen for that agent this pass. Surfaces grooming's blocked items. Idempotent (a task
 * with an artifact is skipped), a no-op when nothing's new. Never throws.
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

  const {
    getOpenAssignedTasks,
    getBoardTasks,
    getTaskBlockers,
    setAutoWorkSignature,
    getTaskEngagementStates,
    ensureConfirmAskAt,
    markConfirmAsked,
  } = await import("./tasks.server");
  const { listArtifacts } = await import("../artifacts/artifacts.server");
  const { enqueueTurn } = await import("./turns.server");
  const { isStructuredWorkflowRequired } = await import("../identity/agent-workflow-config.server");

  // Every open, assigned, unblocked task regardless of its current stage (BACKLOG..IN_REVIEW) — bucketed
  // per agent below. Already ordered by priority_rank, so backlog/up-next slices stay priority-ordered.
  const assigned = await getOpenAssignedTasks(email);
  const signature = backlogSignature(assigned);

  if (!assigned.length && !opts.force) {
    await setAutoWorkSignature(email, signature);
    return { ok: true, skipped: true, reason: "empty", enqueued: 0, promoted: 0, blocked: 0, remaining: 0, runId };
  }

  const byAgent = new Map<string, AgentBucket>();
  for (const t of assigned) {
    const agent = t.assigned_agent;
    if (!agent || !AGENT_BY_ID[agent as AgentId]) continue;
    const bucket = byAgent.get(agent) ?? { backlog: [], upNext: [], doing: [], inReview: [] };
    switch ((t.status ?? "").toUpperCase()) {
      case "UP_NEXT":
        bucket.upNext.push(t);
        break;
      case "DOING":
        bucket.doing.push(t);
        break;
      case "IN_REVIEW":
        bucket.inReview.push(t);
        break;
      default:
        bucket.backlog.push(t); // BACKLOG/TODO/PLANNING/READY/null
    }
    byAgent.set(agent, bucket);
  }

  // Decide promotions per agent (in memory — the mirror hasn't synced yet), then write them all in one
  // batch call to journey (mirrors grooming's batch write; one round-trip instead of N). UP_NEXT top-up
  // from BACKLOG is unconditional (never gated); only the UP_NEXT->DOING step is gated behind the
  // confirm-intent flow when requireStructuredWorkflow is ON for that agent (Part 0/1 of
  // docs/plan-wip-confirm-review-gate.md) — a pending (asked-but-unconfirmed) task occupies its UP_NEXT
  // slot but never competes for the DOING slot, so one unanswered ask can't starve the rest of the lane.
  const promotions: { task_id: string; status: string }[] = [];
  type Candidate = { agent: string; task: BoardTaskRow; doingList: BoardTaskRow[] };
  const doingSlotCandidates: Candidate[] = [];
  for (const [agent, bucket] of byAgent.entries()) {
    const frozen = bucket.inReview.length >= REVIEW_CAP;
    if (frozen) continue;
    const room = Math.max(0, UP_NEXT_CAP - bucket.upNext.length);
    const toPromote = bucket.backlog.slice(0, room);
    for (const t of toPromote) promotions.push({ task_id: t.id, status: "UP_NEXT" });
    const upNextAfterTopUp = [...bucket.upNext, ...toPromote];
    if (bucket.doing.length < DOING_CAP && upNextAfterTopUp.length) {
      doingSlotCandidates.push({ agent, task: upNextAfterTopUp[0], doingList: bucket.doing });
    }
  }

  const engagementByTaskId = await getTaskEngagementStates(doingSlotCandidates.map((c) => c.task.id));
  const requiredByAgent = new Map(
    await Promise.all(
      [...new Set(doingSlotCandidates.map((c) => c.agent))].map(
        async (agent): Promise<[string, boolean]> => [agent, await isStructuredWorkflowRequired(email, agent)],
      ),
    ),
  );

  const doingCandidates: BoardTaskRow[] = [];
  const needsAskAt: string[] = [];
  const confirmDue: { agent: string; task: BoardTaskRow }[] = [];
  const now = Date.now();
  for (const c of doingSlotCandidates) {
    let doingList = c.doingList;
    if (!requiredByAgent.get(c.agent)) {
      promotions.push({ task_id: c.task.id, status: "DOING" });
      doingList = [...c.doingList, c.task];
    } else {
      const state = engagementByTaskId.get(c.task.id);
      const status = state?.confirm_status ?? "awaiting";
      if (status === "confirmed") {
        promotions.push({ task_id: c.task.id, status: "DOING" });
        doingList = [...c.doingList, c.task];
      } else if (status === "awaiting") {
        if (!state?.confirm_ask_at) {
          needsAskAt.push(c.task.id);
        } else if (new Date(state.confirm_ask_at).getTime() <= now) {
          confirmDue.push({ agent: c.agent, task: c.task });
        }
        // else: jitter hasn't elapsed yet — wait for a later pass
      }
      // status === "asked": already sent, waiting on the user's reply — nothing to do this pass
    }
    doingCandidates.push(...doingList.slice(0, DOING_CAP));
  }

  if (needsAskAt.length) {
    const jitterMs = () => CONFIRM_JITTER_MIN_MS + Math.random() * (CONFIRM_JITTER_MAX_MS - CONFIRM_JITTER_MIN_MS);
    await Promise.all(
      needsAskAt.map((taskId) => ensureConfirmAskAt(taskId, email, new Date(now + jitterMs()).toISOString()).catch(() => {})),
    );
  }

  let confirmAsked = 0;
  for (const { agent, task } of confirmDue) {
    try {
      const justAsked = await markConfirmAsked(task.id);
      if (!justAsked) continue; // another pass already asked (race) — don't double-send
      const id = `autowork-confirm-${runId}-${task.id}`;
      await enqueueTurn(id, `dm-${agent}`, email, turnPayload({ assigned_agent: agent }, confirmIntentDirective(task), tz, caller, "push"));
      confirmAsked++;
    } catch {
      /* enqueue failure is non-fatal — confirm_ask_at already passed, so it's retried next pass */
    }
  }

  let promoted = 0;
  if (promotions.length) {
    try {
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "batch_update_tasks",
        args: { updates: promotions },
        caller: caller ?? {},
        context: { source: "huddle" },
      });
      if (r.ok) {
        try {
          const p = JSON.parse(r.output || "{}") as { updated?: number };
          promoted = typeof p.updated === "number" ? p.updated : promotions.length;
        } catch {
          promoted = promotions.length;
        }
      }
    } catch {
      /* promotion write failed — the backlog stays as-is and is retried next pass */
    }
  }

  // Idempotency + rotation: a task already backed by an artifact is "done researching" — skip it (it's
  // waiting on create_artifact's IN_REVIEW flip or the user's review, not on more work here).
  const existing = await listArtifacts(email);
  const withArtifact = new Set(existing.map((a) => a.task_id).filter(Boolean) as string[]);
  const candidates = doingCandidates.filter((t) => !withArtifact.has(t.id));

  // Blocked = tasks an agent flagged (a task_blockers row) — with the REAL reason it recorded. Not a guess.
  const board = await getBoardTasks(email);
  const blockers = await getTaskBlockers(email);
  const blockedTitles = board
    .filter((t) => !t.completed_at && blockers.has(t.id))
    .map((t) => {
      const b = blockers.get(t.id);
      return b ? `${t.title} — ${b.reason}` : t.title;
    });

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
  return { ok: true, skipped: false, enqueued, promoted, blocked: blockedTitles.length, remaining, confirmAsked, runId };
}
