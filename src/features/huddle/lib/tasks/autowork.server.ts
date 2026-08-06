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
import { classifyTaskMode, modeProposalHint } from "./workability";

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
function confirmIntentDirective(task: {
  id: string;
  title: string;
  assigned_agent: string | null;
  category?: string | null;
  tags?: string[] | null;
}): string {
  // Assist/produce router: shape the proposal so the user CONFIRMS a concrete assumed action rather than
  // explaining from scratch, and so an assist task (e.g. "Go to church") proposes a reminder, not a
  // fabricated document. The mode hint also tells the agent to self-correct if the mode is wrong — the
  // user's confirmation is the final catch for a mis-classification.
  const mode = classifyTaskMode(task);
  return (
    `This task is on the board for you: "${task.title}". Before starting (or continuing) the work, ` +
    `confirm with the user what they actually want to achieve here — ground your understanding in ` +
    `their Executive Profile and anything you remember about their goals (already in your context). ` +
    `In ONE natural, brief message (not an interrogation): say what you believe they're trying to ` +
    `accomplish with this task, propose a concrete, testable Definition of Done, and ask them to ` +
    `confirm it, add to it, or correct it.\n` +
    `${modeProposalHint(mode)}\n` +
    `Once you understand their reply (confirmed as-is, or with their additions/corrections folded in), ` +
    `call confirm_task_intent with task_id "${task.id}" and the final definition_of_done text — this ` +
    `locks it in. Do NOT call confirm_task_intent before they've actually replied; this first message ` +
    `is only the ask.\n` +
    `Immediately after confirm_task_intent succeeds, in this SAME turn, draft your APPROACH — how you'll ` +
    `actually get to that Definition of Done (method, sources, structure, depth) — and call ` +
    `propose_approach with task_id "${task.id}" and that approach. This is graded automatically; the ` +
    `user is never involved in it. If it comes back needing revision, redraft and call propose_approach ` +
    `again with the feedback folded in. Only once it comes back approved should you actually start the ` +
    `real work. If it comes back escalated (you've hit the revision limit), say so to the user directly ` +
    `in your next reply and ask them to weigh in — don't keep retrying on your own. Do not create tasks ` +
    `or send email.`
  );
}

// Minute-granular confirm-ask delivery window + throttle. The ASK's jittered instant (confirm_ask_at)
// is what spreads reach-outs across the day; firing is checked every heartbeat so each ask goes out at
// ~its own instant instead of bunching onto the 3x/day pass. A working-hours window keeps a late-jittered
// ask (e.g. armed 5pm + 4h) from pinging at 9pm — it waits for the window to reopen. A small per-user
// per-tick cap smooths any pile-up so it still feels like a teammate, not a blast.
const CONFIRM_FIRE_WINDOW_START = 9; // local hour, inclusive
const CONFIRM_FIRE_WINDOW_END = 18; // local hour, exclusive
const CONFIRM_FIRE_MAX_PER_USER_PER_TICK = 2;

/**
 * Fire every confirm-intent ask whose jittered `confirm_ask_at` has elapsed, at its own instant — the
 * random fan-out across the working day (vs the old "all bunch onto 9/13/17"). Called each scheduler
 * heartbeat (scheduler.server.ts). ARMING (setting confirm_ask_at) stays on the auto-work/groom passes;
 * only FIRING is decoupled here. `markConfirmAsked` is set-once (awaiting→asked), so this never
 * double-sends against the full pass's own confirmDue path. Never throws.
 */
export async function fireDueConfirmAsks(now: Date = new Date()): Promise<number> {
  let due: import("./tasks.server").DueConfirmAsk[];
  try {
    const { getDueConfirmAsks } = await import("./tasks.server");
    due = await getDueConfirmAsks(now.toISOString(), 100);
  } catch {
    return 0;
  }
  if (!due.length) return 0;

  const { markConfirmAsked } = await import("./tasks.server");
  const { enqueueTurn } = await import("./turns.server");
  const { resolveJobCadence } = await import("../identity/scheduling-config.server");

  const byUser = new Map<string, typeof due>();
  for (const row of due) {
    const arr = byUser.get(row.user_email) ?? [];
    arr.push(row);
    byUser.set(row.user_email, arr);
  }

  let fired = 0;
  for (const [email, rows] of byUser) {
    // Working-hours window in the user's own tz (from their scheduling config; ET default).
    let tz = "America/New_York";
    try {
      tz = (await resolveJobCadence(email, "autowork")).tz || tz;
    } catch {
      /* default tz */
    }
    let localHour = 0;
    try {
      localHour =
        Number(
          new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now),
        ) % 24;
    } catch {
      localHour = now.getUTCHours();
    }
    if (!(localHour >= CONFIRM_FIRE_WINDOW_START && localHour < CONFIRM_FIRE_WINDOW_END)) continue;

    let sent = 0;
    for (const row of rows) {
      if (sent >= CONFIRM_FIRE_MAX_PER_USER_PER_TICK) break;
      if (!row.assigned_agent) continue;
      try {
        const justAsked = await markConfirmAsked(row.task_id); // set-once awaiting→asked; wins the race
        if (!justAsked) continue;
        const caller: Caller = { entra_email: email };
        const directive = confirmIntentDirective({
          id: row.task_id,
          title: row.title,
          assigned_agent: row.assigned_agent,
          category: row.category,
          tags: row.tags,
        });
        await enqueueTurn(
          `autowork-confirm-${row.task_id}`,
          `dm-${row.assigned_agent}`,
          email,
          turnPayload({ assigned_agent: row.assigned_agent }, directive, tz, caller, "push"),
        );
        fired++;
        sent++;
      } catch {
        /* one bad ask never blocks the rest */
      }
    }
  }
  return fired;
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
  opts: { timeZone?: string; force?: boolean; runId?: string; promoteOnly?: boolean } = {},
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
  // PARKING LOT: a task tagged `parking-lot` opts OUT of all automation — it is filtered here at
  // candidate-selection time, so it is never promoted (BACKLOG→UP_NEXT→DOING) and never enqueues a work
  // turn. It stays on the board (typically Backlog) with the tag until the user un-parks it. (ACT-13.)
  const assigned = (await getOpenAssignedTasks(email)).filter(
    (t) => !(t.tags ?? []).includes("parking-lot"),
  );
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
  // Every item staged in an agent's UP_NEXT this pass (existing + freshly promoted), with its agent — used
  // by promoteOnly (the grooming chain) to arm each one's confirm-intent reach-out so agents begin checking
  // in for the whole plate from grooming completion.
  const stagedForConfirm: { agent: string; task: BoardTaskRow }[] = [];
  // freshPromotion=false candidates are tasks ALREADY sitting in DOING (however they got there — a
  // normal earlier promotion, or a race/stale-mirror read that skipped the gate entirely, as happened
  // 2026-08-05: a task reached DOING and completed to IN_REVIEW without ever confirming intent). They
  // must pass the SAME confirm-intent check as a fresh UP_NEXT->DOING promotion before they're eligible
  // for a new research turn — closing that gap regardless of how a task lands in DOING.
  type Candidate = { agent: string; task: BoardTaskRow; freshPromotion: boolean };
  const doingSlotCandidates: Candidate[] = [];
  const doingCandidates: BoardTaskRow[] = [];
  for (const [agent, bucket] of byAgent.entries()) {
    for (const t of bucket.doing.slice(0, DOING_CAP)) {
      doingSlotCandidates.push({ agent, task: t, freshPromotion: false });
    }
    const frozen = bucket.inReview.length >= REVIEW_CAP;
    if (frozen) continue;
    const room = Math.max(0, UP_NEXT_CAP - bucket.upNext.length);
    const toPromote = bucket.backlog.slice(0, room);
    for (const t of toPromote) promotions.push({ task_id: t.id, status: "UP_NEXT" });
    const upNextAfterTopUp = [...bucket.upNext, ...toPromote];
    for (const t of upNextAfterTopUp) stagedForConfirm.push({ agent, task: t });
    if (bucket.doing.length < DOING_CAP && upNextAfterTopUp.length) {
      doingSlotCandidates.push({ agent, task: upNextAfterTopUp[0], freshPromotion: true });
    }
  }

  // promoteOnly (the grooming→auto-work chain): ONLY top up UP_NEXT from the freshly-ranked backlog.
  // Do NOT promote to DOING, enqueue research turns, or flip anything to review — all of that belongs to
  // the full cadence pass, behind the confirm-intent gate. `promotions` at this point holds ONLY the
  // BACKLOG→UP_NEXT top-up (DOING entries are pushed later, after the gate), and staging into UP_NEXT
  // starts no work, so it needs no confirmation. This is what makes grooming fill "Up next" without ever
  // "working" an unconfirmed task.
  if (opts.promoteOnly) {
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
        /* top-up write failed — backlog stays as-is, retried by the next full pass */
      }
    }
    // Chain the confirm-intent REACH-OUT scheduling to grooming completion: arm each freshly-staged
    // UP_NEXT item with a jittered `confirm_ask_at` (one-time, 15min–4h out), for gated agents whose
    // intent isn't already confirmed/asked. This SCHEDULES the reach-out relative to grooming; the
    // auto-work cadence (9/13/17) is what FIRES each ask once its jittered instant passes, so agents
    // begin checking in for confirmations staggered across the day from the moment the board was groomed.
    // We schedule only — no ask is fired and no work starts here (that stays behind the gate on cadence).
    if (stagedForConfirm.length) {
      try {
        const armStates = await getTaskEngagementStates(stagedForConfirm.map((f) => f.task.id));
        const armRequired = new Map(
          await Promise.all(
            [...new Set(stagedForConfirm.map((f) => f.agent))].map(
              async (a): Promise<[string, boolean]> => [a, await isStructuredWorkflowRequired(email, a)],
            ),
          ),
        );
        const armNow = Date.now();
        const armJitter = () => CONFIRM_JITTER_MIN_MS + Math.random() * (CONFIRM_JITTER_MAX_MS - CONFIRM_JITTER_MIN_MS);
        await Promise.all(
          stagedForConfirm
            .filter((f) => {
              if (!(armRequired.get(f.agent) ?? true)) return false; // discretionary agent — no ask needed
              const s = armStates.get(f.task.id);
              return (s?.confirm_status ?? "awaiting") !== "confirmed" && !s?.confirm_ask_at; // not confirmed & not already armed
            })
            .map((f) =>
              ensureConfirmAskAt(f.task.id, email, new Date(armNow + armJitter()).toISOString()).catch(() => {}),
            ),
        );
      } catch {
        /* arming is best-effort — the next full cadence pass still schedules any un-armed asks */
      }
    }
    await setAutoWorkSignature(email, signature);
    return { ok: true, skipped: false, reason: "promote_only", enqueued: 0, promoted, blocked: 0, remaining: 0, runId };
  }

  const engagementByTaskId = await getTaskEngagementStates(doingSlotCandidates.map((c) => c.task.id));
  const requiredByAgent = new Map(
    await Promise.all(
      [...new Set(doingSlotCandidates.map((c) => c.agent))].map(
        async (agent): Promise<[string, boolean]> => [agent, await isStructuredWorkflowRequired(email, agent)],
      ),
    ),
  );

  const needsAskAt: string[] = [];
  const confirmDue: { agent: string; task: BoardTaskRow }[] = [];
  const now = Date.now();
  for (const c of doingSlotCandidates) {
    let promotedToDoing = false;
    const state = engagementByTaskId.get(c.task.id);
    if (!(requiredByAgent.get(c.agent) ?? true)) {
      // Fail-closed: an agent missing from the map (or a fail-open upstream) defaults to REQUIRED, so a
      // config hiccup can never silently treat a task as ungated and auto-promote it to DOING.
      promotedToDoing = true;
    } else {
      const status = state?.confirm_status ?? "awaiting";
      if (status === "confirmed") {
        // DoD confirmed — also needs an APPROVED approach (the pre-work gate, approach-gate.server.ts)
        // before real work starts. The assigned agent resolves this inline, in the same turn, right
        // after confirm_task_intent — 'pending' here just means that hasn't happened yet (or the turn
        // never reached it); 'escalated' means its cap was exhausted and the agent already raised it
        // with the user directly. Neither is auto-promoted; only 'approved' is.
        promotedToDoing = state?.approach_status === "approved";
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
    // A task with an OPEN clarifying question (ask_clarifying_question) is paused — don't enqueue a
    // new research turn while the agent is waiting on the user's answer, whether or not it's otherwise
    // eligible. Applies regardless of requireStructuredWorkflow since the tool is generally available.
    if (promotedToDoing && state?.clarify_status === "open") {
      promotedToDoing = false;
    }
    if (promotedToDoing) {
      if (c.freshPromotion) promotions.push({ task_id: c.task.id, status: "DOING" });
      doingCandidates.push(c.task);
    }
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

  // Self-heal: a DOING task that already has an artifact should have flipped to IN_REVIEW the instant
  // it was saved (create_artifact -> ensureReviewFlip, tasks.server.ts). If that write is still pending
  // — e.g. the review gate sent it back for one revision and the corrective pass never came — it would
  // otherwise sit here silently forever, since the idempotency filter above never reconsiders it. Retry
  // the flip every pass instead; ensureReviewFlip itself flags a repeatedly-failing task via
  // task_blockers, which drops it out of getOpenAssignedTasks so it surfaces to the user rather than
  // looping invisibly. (This is what stranded 5 real tasks for ~9 days — 2026-08-04 incident.)
  const stuckWithArtifact = doingCandidates.filter((t) => withArtifact.has(t.id));
  if (stuckWithArtifact.length) {
    const { ensureReviewFlip } = await import("./tasks.server");
    await Promise.all(stuckWithArtifact.map((t) => ensureReviewFlip(t.id, email, caller, t.assigned_agent).catch(() => {})));
  }

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
