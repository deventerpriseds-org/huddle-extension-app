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
  /** Always 0 since 2026-10-27: a pass only ARMS confirm-asks; fireDueConfirmAsks (heartbeat) is the one sender. */
  confirmAsked?: number;
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
    `1) You MUST call create_artifact to SAVE your full findings as a document — detailed, with ` +
    `your analysis, the sources you used, and a clear recommendation or concrete next steps. Choose the ` +
    `\`format\` that actually fits what you produced rather than defaulting blindly: 'md' for plain prose ` +
    `(still the right default), 'docx' when the user will send or print it, 'pptx' for a deck, and ` +
    `'mermaid'/'html'/'svg' when the finding is a diagram or a visual. Set task_id ` +
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

// Confirm-intent reach-out scheduling (docs/plan-wip-confirm-review-gate.md, Part 1): a fresh UP_NEXT
// candidate is armed with a ONE-TIME `confirm_ask_at` placed INSIDE a fan-out window (business 9–18 +
// evening 20–22 by default) and SEQUENCED a randomized gap after the previous ask (see
// nextSpacedFanSlotIso / armConfirmAsksSpaced below), so multiple agents' fresh items arrive spread ≥45
// min apart across the day rather than bunched in one autowork pass, and never outside those hours.

/**
 * The directive the assigned agent runs to confirm intent + propose a Definition of Done. `followUp` = this is
 * a RE-ask (the user never answered an earlier check-in on the same task): same instructions — including
 * propose_task_intent, so the Confirm button has a recorded proposal to act on — but it opens as a follow-up
 * to the earlier message, not a first-contact greeting (owner OQ-2: a new message in the same DM thread).
 */
export function confirmIntentDirective(
  task: {
    id: string;
    title: string;
    assigned_agent: string | null;
    category?: string | null;
    tags?: string[] | null;
  },
  opts: { followUp?: boolean } = {},
): string {
  // Assist/produce router: shape the proposal so the user CONFIRMS a concrete assumed action rather than
  // explaining from scratch, and so an assist task (e.g. "Go to church") proposes a reminder, not a
  // fabricated document. The mode hint also tells the agent to self-correct if the mode is wrong — the
  // user's confirmation is the final catch for a mis-classification.
  const mode = classifyTaskMode(task);
  const opener = opts.followUp
    ? `FOLLOW-UP: you already checked in with the user about this task earlier and haven't heard back. ` +
      `In ONE natural, brief message (not an interrogation, and not a guilt-trip): open by circling back ` +
      `on your earlier check-in (e.g. "Circling back on this one —"), not with a fresh first-contact ` +
      `greeting, then briefly restate what you believe they're trying to accomplish with this task, ` +
      `propose a concrete, testable Definition of Done, and ask them to confirm it, add to it, or correct it.\n`
    : `In ONE natural, brief message (not an interrogation): open with a brief, natural greeting that ` +
      `frames what this is about (e.g. "Hi — before I get going on this, wanted to check something:"), ` +
      `then say what you believe they're trying to accomplish with this task, propose a concrete, ` +
      `testable Definition of Done, and ask them to confirm it, add to it, or correct it.\n`;
  return (
    `This task is on the board for you: "${task.title}". Before starting (or continuing) the work, ` +
    `confirm with the user what they actually want to achieve here — ground your understanding in ` +
    `their Executive Profile and anything you remember about their goals (already in your context). ` +
    opener +
    `${modeProposalHint(mode)}\n` +
    `In this SAME message/turn, also call propose_task_intent with task_id "${task.id}", task_title ` +
    `"${task.title}", and the definition_of_done you just proposed — this records what you proposed ` +
    `immediately, before they've replied, so the user can act on it with one tap. This is separate from ` +
    `confirm_task_intent below and does not confirm or lock in anything by itself.\n` +
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

/**
 * The internal nudge for a task whose Definition of Done the user CONFIRMED but whose approach was never
 * proposed (the confirm turn didn't reach propose_approach) — without it nothing ever asks again and the task
 * sits in Up Next forever (F10). The user is not involved: DoD stays confirmed, nobody is asked to re-confirm.
 */
export function approachRedriveDirective(task: { id: string; title: string }): string {
  return (
    `The user already CONFIRMED the Definition of Done for "${task.title}", but your approach for it was never ` +
    `submitted, so the work can't start. Do NOT ask the user to re-confirm the Definition of Done — it is ` +
    `already locked in. Draft your APPROACH now — how you'll actually get to that Definition of Done (method, ` +
    `sources, structure, depth) — and call propose_approach with task_id "${task.id}" and that approach. It is ` +
    `graded automatically. If it comes back needing revision, redraft and call propose_approach again with the ` +
    `feedback folded in. If it comes back escalated, say so to the user plainly and ask them to weigh in. Do not ` +
    `start the real work until the approach is approved. Keep any reply to the user short. Do not create tasks ` +
    `or send email.`
  );
}

// Minute-granular confirm-ask throttle. Reach-outs are spread by ARMING each ask INSIDE a fan-out window
// (see nextSpacedFanSlotIso — business 9–18 + evening 20–22 by default), SEQUENCED a randomized 45–90 min
// gap after the prior ask so they never bunch. Firing is checked every heartbeat and only proceeds while
// we're inside a window AND at least the gap's minimum has passed since the user's LAST SENT ask
// (getLastConfirmSentAt) — first asks and re-asks alike.
// ONE per user per tick (was 2): with re-asks riding the same chain, two due asks in one tick were two pushes
// in the same minute, which breaks the "never closer than the gap" property the chain exists for (AC-41). Any
// other ask that is due in that tick is re-fanned a spaced slot after the one just sent.
const CONFIRM_FIRE_MAX_PER_USER_PER_TICK = 1;

// ── Fan-out window math ─────────────────────────────────────────────────────────────────────────
// Windows are inclusive-start/exclusive-end LOCAL hour ranges (in the user's tz). We place each ask a
// randomized 45–90 min gap after the previous one, always inside a window — instead of the old
// `now + jitter(15m–4h)` (any hour, then a fire-guard held+dumped the overnight batch at 9am) OR an
// independent uniform minute (no min spacing, so a groom batch could bunch reach-outs minutes apart).
type WinRange = { start: number; end: number };
type TzClock = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function tzClock(d: Date, tz: string): TzClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const o: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") o[p.type] = p.value;
  let h = Number(o.hour);
  if (h === 24) h = 0; // some engines emit "24" at midnight under hour12:false — normalize
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h, mi: Number(o.minute), s: Number(o.second) };
}

/** ms to add to a wall clock read as UTC to recover the true instant, under `d`'s tz rules. */
function tzOffsetMs(d: Date, tz: string): number {
  const c = tzClock(d, tz);
  const asUTC = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s);
  return asUTC - Math.floor(d.getTime() / 1000) * 1000;
}

/** Is `now` currently inside any fan-out window (local hours in tz)? */
export function insideFanWindow(now: Date, tz: string, windows: WinRange[]): boolean {
  const c = tzClock(now, tz);
  const m = c.h * 60 + c.mi;
  return windows.some((w) => m >= w.start * 60 && m < w.end * 60);
}

/**
 * The next fan-out slot placed a RANDOMIZED gap after `prev`, so consecutive reach-outs are spaced
 * (default 45–90 min) instead of independently uniform (which bunches). Take `prev + rand[gapMin,gapMax]`;
 * if that instant is inside a window, use it; otherwise roll forward to the next window's start (same day,
 * then first window next day) plus a small in-window jitter so the first ask of a window isn't pinned to
 * the exact hour. Always returns an instant that is inside a window and > prev. DST self-heal: a skewed
 * instant is re-checked at fire time by fireDueConfirmAsks and re-fanned if it fell outside a window.
 */
export function nextSpacedFanSlotIso(prev: Date, tz: string, windows: WinRange[], gapMinMs: number, gapMaxMs: number): string {
  const wins = windows.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const randInt = (a: number, b: number) => a + Math.floor(Math.random() * Math.max(1, b - a)); // [a,b)
  if (!wins.length) return new Date(prev.getTime() + Math.max(gapMinMs, 60_000)).toISOString(); // no windows → gap fallback
  let candMs = prev.getTime() + randInt(gapMinMs, gapMaxMs);
  for (let guard = 0; guard < 10; guard++) {
    const cand = new Date(candMs);
    const c = tzClock(cand, tz);
    const m = c.h * 60 + c.mi;
    if (wins.some((w) => m >= w.start * 60 && m < w.end * 60)) return cand.toISOString();
    // Outside every window → snap to the next window start (later today, else first window tomorrow).
    let target: number | null = null;
    let dayOffset = 0;
    for (const w of wins) {
      if (w.start * 60 > m) {
        target = w.start * 60;
        break;
      }
    }
    if (target === null) {
      target = wins[0].start * 60;
      dayOffset = 1;
    }
    const offset = tzOffsetMs(cand, tz);
    const jitter = randInt(0, Math.min(gapMinMs, 30 * 60_000)); // ≤ gapMin and ≤30min → stays well inside the ≥2h window
    candMs = Date.UTC(c.y, c.mo - 1, c.d + dayOffset, Math.floor(target / 60), target % 60, 0) - offset + jitter;
  }
  return new Date(candMs).toISOString();
}

/** One ask to place on the spacing chain: a FIRST ask (awaiting, never armed) or a RE-ask (asked, unanswered). */
export type ArmItem = { taskId: string; kind: "first" | "reask" };

/**
 * Arm each item's confirm-ask, SEQUENCED so consecutive reach-outs for this user are spaced by a randomized gap
 * (resolveConfirmGap, default 45–90 min) and land only inside the fan-out windows. The cursor is anchored on the
 * user's latest already-pending ask — first asks AND re-armed re-asks (getLatestPendingConfirmAskAt) — so a later
 * pass doesn't collide with one already scheduled, falling back to `now`. Re-asks ride THIS chain rather than a
 * selector of their own (owner, 2026-10-27: "the throttle already exists"). Best-effort throughout: a
 * config/lookup failure degrades to defaults / now-anchor, and a single arm write failing never blocks the rest.
 * Both writes are set-once per round (`ensureConfirmAskAt` for a first ask; `armConfirmReAskAt` for a re-ask), so
 * a task that already has a pending instant is left unchanged — and a re-ask that did NOT arm gives its slot back.
 */
async function armConfirmAsksSpaced(items: ArmItem[], email: string, tz: string, windows: WinRange[]): Promise<void> {
  if (!items.length) return;
  const { resolveConfirmGap, CONFIRM_GAP_DEFAULT } = await import("../identity/scheduling-config.server");
  const { getLatestPendingConfirmAskAt, ensureConfirmAskAt, armConfirmReAskAt } = await import("./tasks.server");
  let gap = CONFIRM_GAP_DEFAULT;
  try {
    gap = await resolveConfirmGap(email);
  } catch {
    /* default gap */
  }
  const gapMinMs = Math.max(1, gap.min) * 60_000;
  const gapMaxMs = Math.max(gap.min + 1, gap.max) * 60_000;
  let floor: Date | null = null;
  try {
    floor = await getLatestPendingConfirmAskAt(email);
  } catch {
    /* no floor — anchor on now */
  }
  // Cursor = the latest instant we've placed so far. Seed from the user's last pending ask (if any is
  // still in the future) or now, so the FIRST new ask lands a full gap after whichever is later.
  let cursor = new Date(Math.max(Date.now(), floor ? floor.getTime() : 0));
  for (const item of items) {
    const slotIso = nextSpacedFanSlotIso(cursor, tz, windows, gapMinMs, gapMaxMs);
    if (item.kind === "first") {
      cursor = new Date(slotIso);
      await ensureConfirmAskAt(item.taskId, email, slotIso).catch(() => {});
    } else {
      const armed = await armConfirmReAskAt(item.taskId, email, slotIso).catch(() => false);
      if (armed) cursor = new Date(slotIso); // not armed (raced / answered meanwhile) → the slot stays free
    }
  }
}

/** Terms shared by the arming planner and the pass: what an agent's ask LANE is, and who may be asked. */
type EngagementLike = {
  confirm_status?: string | null;
  confirm_ask_at?: string | Date | null;
  confirm_last_sent_at?: string | Date | null;
  clarify_status?: string | null;
  approach_status?: string | null;
};

const ms = (v: string | Date | null | undefined): number | null => (v ? new Date(v).getTime() : null);

/**
 * May this item be confirm-asked at all? Not yet confirmed, not paused on an open clarifying question (AC-33),
 * and not escalated (the owner-override flow owns it — AC-36). A missing row = never asked = awaiting.
 */
function askEligible(s: EngagementLike | undefined): boolean {
  const status = s?.confirm_status ?? "awaiting";
  return (status === "awaiting" || status === "asked") && s?.clarify_status !== "open" && s?.approach_status !== "escalated";
}

/** Armed and not yet sent (mirrors tasks.server.ts ARMED_UNSENT_SQL). */
function armedUnsent(s: EngagementLike | undefined): boolean {
  const at = ms(s?.confirm_ask_at);
  if (at === null) return false;
  if ((s?.confirm_status ?? "awaiting") === "awaiting") return true;
  return s?.confirm_status === "asked" && at > (ms(s?.confirm_last_sent_at) ?? -Infinity);
}

/**
 * An agent's ASK LANE, in lane order: its unconfirmed in-flight DOING item (if any) first, then EVERY Up Next
 * item (owner, 2026-10-27: rotate the whole lane — the lane is already capped, so no second cap). DOING is in
 * the lane on purpose: DOING_CAP=1 means an unconfirmed DOING item (live: tess, reached DOING by a manual move)
 * blocks the agent's whole Up Next from starting, so it is the ask that most needs answering.
 */
function askLane(doing: BoardTaskRow[], upNext: BoardTaskRow[]): BoardTaskRow[] {
  return [...doing.slice(0, DOING_CAP), ...upNext];
}

/**
 * Decide which asks to put on the spacing chain this pass (pure — the rotation rules live here and nowhere else).
 *   FIRST asks: every ask-eligible lane item still 'awaiting' with no instant yet, in lane order.
 *   RE-asks:    per agent, only when NONE of its lane items is already armed-and-unsent (so an agent never has
 *               two asks queued — AC-26 — and re-asks never pile up behind its fresh first asks). Then its
 *               'asked' item whose last SEND is oldest, past the per-item floor (`reaskMinMs`, the owner's 24h),
 *               ties broken by lane order (AC-24/25: keyed on send history, never on a lane index, so a re-sort
 *               between passes can't make it skip or repeat an item). Across agents the oldest send goes first.
 * Only gated agents are asked at all (a discretionary agent's work never waits on a confirm). The result's
 * order IS the chain order: first asks, then re-asks.
 */
export function planConfirmArming(input: {
  lanes: { agent: string; lane: BoardTaskRow[] }[];
  states: Map<string, EngagementLike>;
  required: Map<string, boolean>;
  now: number;
  reaskMinMs: number;
}): ArmItem[] {
  const first: ArmItem[] = [];
  const reasks: { item: ArmItem; sent: number; idx: number }[] = [];
  for (const { agent, lane } of input.lanes) {
    if (!(input.required.get(agent) ?? true)) continue;
    let agentHasPending = false;
    let best: { taskId: string; sent: number; idx: number } | null = null;
    lane.forEach((t, idx) => {
      const s = input.states.get(t.id);
      if (!askEligible(s)) return;
      if (armedUnsent(s)) {
        agentHasPending = true;
        return;
      }
      if ((s?.confirm_status ?? "awaiting") === "awaiting") {
        first.push({ taskId: t.id, kind: "first" });
        agentHasPending = true;
        return;
      }
      const sent = ms(s?.confirm_last_sent_at);
      if (sent === null || input.now - sent < input.reaskMinMs) return;
      if (!best || sent < best.sent) best = { taskId: t.id, sent, idx };
    });
    const chosen = best as { taskId: string; sent: number; idx: number } | null;
    if (!agentHasPending && chosen) reasks.push({ item: { taskId: chosen.taskId, kind: "reask" }, sent: chosen.sent, idx: chosen.idx });
  }
  reasks.sort((a, b) => a.sent - b.sent || a.idx - b.idx);
  return [...first, ...reasks.map((r) => r.item)];
}

/**
 * Fire every confirm-intent ask — FIRST asks and re-armed RE-asks alike — whose spaced `confirm_ask_at` has
 * elapsed, at its own instant. Called each scheduler heartbeat (scheduler.server.ts) and the ONLY place a
 * confirm-ask is sent: ARMING (setting confirm_ask_at) stays on the auto-work/groom passes. Per user, per tick:
 *   - outside the fan-out windows, nothing is sent and every due ask is re-fanned into the next window;
 *   - inside, at most ONE ask is sent, and only once the gap's minimum has passed since the user's last SENT ask
 *     (getLastConfirmSentAt) — so any two confirm pushes are at least that far apart (AC-41); any other ask due
 *     in the same tick is re-fanned a spaced slot after the one just sent;
 *   - a task in its reminder window is skipped (AC-15/40; the lane/blocker/parking filters are in the SQL).
 * Each send is a compare-and-set CLAIM on the row's ask count (claimConfirmAskSend), then a turn with a NEW
 * UNIQUE id — the first ask and every re-ask get their own id and their own chat.pending_turns row (AC-22). If
 * enqueueTurn refuses (id conflict -> false) or throws, the claim is RELEASED and the ask is not counted: an ask
 * that did not go out never reads as sent (AC-23). Never throws (AC-53).
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

  let fired = 0;
  try {
    const { claimConfirmAskSend, releaseConfirmAskSend, reArmConfirmAskAt, getLatestPendingConfirmAskAt, getLastConfirmSentAt } =
      await import("./tasks.server");
    const { enqueueTurn, taskIdsInReminderWindow } = await import("./turns.server");
    const { resolveJobCadence, resolveConfirmFanWindows, CONFIRM_FAN_WINDOWS_DEFAULT, resolveConfirmGap, CONFIRM_GAP_DEFAULT } =
      await import("../identity/scheduling-config.server");

    const byUser = new Map<string, typeof due>();
    for (const row of due) {
      const arr = byUser.get(row.user_email) ?? [];
      arr.push(row);
      byUser.set(row.user_email, arr);
    }

    for (const [email, allRows] of byUser) {
      try {
        // Working-hours window in the user's own tz (from their scheduling config; ET default).
        let tz = "America/New_York";
        try {
          tz = (await resolveJobCadence(email, "autowork")).tz || tz;
        } catch {
          /* default tz */
        }
        // Fan-out windows for this user (business + evening by default).
        let windows = CONFIRM_FAN_WINDOWS_DEFAULT;
        try {
          windows = await resolveConfirmFanWindows(email);
        } catch {
          /* default windows */
        }
        let gap = CONFIRM_GAP_DEFAULT;
        try {
          gap = await resolveConfirmGap(email);
        } catch {
          /* default gap */
        }
        const gapMinMs = Math.max(1, gap.min) * 60_000;
        const gapMaxMs = Math.max(gap.min + 1, gap.max) * 60_000;

        // Re-fan `rows` across the next open window(s), SPACED (45–90 min, config) after `after` and after any
        // ask already on the calendar, so a backlog of due asks never dumps bunched at one edge.
        const reFan = async (rows: typeof allRows, after: Date) => {
          let floor: Date | null = null;
          try {
            floor = await getLatestPendingConfirmAskAt(email);
          } catch {
            /* anchor on `after` */
          }
          let cursor = new Date(Math.max(after.getTime(), floor ? floor.getTime() : 0));
          for (const row of rows) {
            try {
              const slotIso = nextSpacedFanSlotIso(cursor, tz, windows, gapMinMs, gapMaxMs);
              cursor = new Date(slotIso);
              await reArmConfirmAskAt(row.task_id, email, slotIso);
            } catch {
              /* one bad re-arm never blocks the rest */
            }
          }
        };

        // Only fire while we're INSIDE a window. If we're outside one, any ask that's come due is a
        // STRAGGLER (armed the old now+jitter way, or left unsent when a window closed) — re-fan it across
        // the NEXT open window rather than holding the whole batch to dump at the window's opening edge.
        if (!insideFanWindow(now, tz, windows)) {
          await reFan(allRows, now);
          continue;
        }

        // A task in its reminder window has already had its decision made by the user — never ask about it
        // while it waits (same rule runScheduledAutoWork applies at candidate selection). It stays armed, so it
        // is asked once the reminder has fired and it is back in the lane.
        let inReminder = new Set<string>();
        try {
          inReminder = await taskIdsInReminderWindow(email);
        } catch {
          /* no reminder filter */
        }
        const rows = allRows.filter((r) => r.assigned_agent && !inReminder.has(r.task_id));
        if (!rows.length) continue;

        // Fire-time half of the spacing chain. If we cannot read when the user was last asked, we cannot prove
        // a send would respect the gap — so this user waits a tick rather than risk a double-buzz.
        let lastSent: Date | null;
        try {
          lastSent = await getLastConfirmSentAt(email);
        } catch {
          continue;
        }
        if (lastSent && now.getTime() - lastSent.getTime() < gapMinMs) continue;

        let sent = 0;
        const unsent: typeof rows = [];
        for (const row of rows) {
          if (sent >= CONFIRM_FIRE_MAX_PER_USER_PER_TICK) {
            unsent.push(row);
            continue;
          }
          const followUp = row.confirm_status === "asked";
          const claim = await claimConfirmAskSend(row.task_id, row.confirm_ask_count).catch(() => null);
          if (!claim) continue; // another tick sent it / it was answered or reassigned meanwhile
          const stamp = now.getTime().toString(36);
          // NEW id for every ask: never the bare legacy `autowork-confirm-${task_id}`, which ON CONFLICT DO
          // NOTHING made a silent no-op for any second ask on the same task (F3).
          const turnId = followUp
            ? `autowork-reask-${row.task_id}-${claim.count}-${stamp}`
            : `autowork-confirm-${row.task_id}-${claim.count}-${stamp}`;
          const directive = confirmIntentDirective(
            { id: row.task_id, title: row.title, assigned_agent: row.assigned_agent, category: row.category, tags: row.tags },
            { followUp },
          );
          let ok = false;
          try {
            ok = await enqueueTurn(
              turnId,
              `dm-${row.assigned_agent}`,
              email,
              turnPayload({ assigned_agent: row.assigned_agent }, directive, tz, { entra_email: email }, "push"),
            );
          } catch {
            ok = false;
          }
          if (!ok) {
            // Refused or failed: put the row back exactly as it was (still armed, still due) and stop for this
            // user this tick — the next tick retries with a fresh id.
            await releaseConfirmAskSend(row.task_id, claim, {
              status: row.confirm_status,
              lastSentAt: row.confirm_last_sent_at,
            }).catch(() => {});
            break;
          }
          fired++;
          sent++;
        }
        // Whatever else was due this tick goes back on the chain AFTER the ask just sent, instead of firing a
        // minute later at the gap's exact minimum (which would turn a backlog into a metronome).
        if (sent && unsent.length) await reFan(unsent, now);
        // Queue the NEXT ask the moment one goes out, so the loop through the lane is paced only by the spacing
        // chain — not by waiting for the next 9/13/17 cadence pass (which made it ≤3 re-asks per agent per day).
        if (sent) await runScheduledAutoWork({ entra_email: email }, { timeZone: tz, armOnly: true }).catch(() => {});
      } catch {
        /* one user's failure never blocks the rest */
      }
    }
  } catch {
    /* a module/config failure: report what was sent so far, never throw into the heartbeat */
  }
  return fired;
}

/**
 * One blocked item, carried STRUCTURED rather than pre-flattened to a string.
 *
 * Why structured: the previous shape was `titles: string[]` built as `` `${title} — ${reason}` `` and then
 * `slice(0, 120)`-ed here. Appending an owner to that composed string puts the name exactly where the slice
 * cuts, so a long title+reason would silently drop the very thing this fix adds. Keeping the parts separate
 * lets each be truncated on its own budget and the owner rendered last-but-unclipped.
 */
interface BlockedItem {
  title: string;
  reason?: string;
  /** Display name, already resolved from roster data — never an id, never a slug. */
  ownerName?: string;
}

/**
 * Resolve an assignee id to the display name used in "<X> needs you on this" — the SINGLE source for
 * that decision, shared by autowork and the standup digest so the two surfaces cannot drift.
 *
 * Returns undefined for a null, unknown, or stale id, which callers render as an ownerless line. It
 * deliberately does NOT fall back to the id: this string is rendered as a PERSON, and a slug reads as
 * a confidently-wrong instruction to go talk to "sam-trent-old". (`agentName()` in standup.server.ts
 * does fall back, correctly, because there the id is a label rather than a sentence subject.)
 *
 * Exported so a test can mutate it and see BOTH surfaces fail — previously each call site inlined its
 * own copy of this expression and only one of them was covered.
 */
export function blockedOwnerName(agentId: string | null | undefined): string | undefined {
  return agentId ? AGENT_BY_ID[agentId as AgentId]?.name : undefined;
}

/**
 * Render ONE blocked item as a directive line. Exported and pure so the edge cases that actually bite
 * here — a missing/unknown owner, and truncation eating the appended name — are unit-testable without
 * standing up a board, a DB, or an LLM.
 */
export function renderBlockedLine(it: BlockedItem): string {
  const title = it.title.slice(0, 90);
  const reason = it.reason ? ` — ${it.reason.slice(0, 90)}` : "";
  // Ownerless items must still read as a grammatical sentence — never "undefined needs you" and never
  // the raw id. `ownerName` is already undefined for a null assignee AND for an unknown/stale id, so
  // this single branch covers both without a second guard.
  const who = it.ownerName ? ` — ${it.ownerName} needs you on this` : "";
  // The owner clause is appended AFTER title/reason are each bounded, so however long they are the name
  // is never the thing that gets sliced off.
  return `- ${title}${reason}${who}`;
}

/** Surface grooming-flagged blocked items in the coordinator's DM (report-only). One short turn. */
async function surfaceBlocked(opts: { email: string; tz: string; caller: Caller; items: BlockedItem[]; runId: string }): Promise<void> {
  const list = opts.items.slice(0, 8).map(renderBlockedLine).join("\n");
  const directive =
    `Some of the user's assigned tasks are blocked pending THEIR input — the team can't proceed without a ` +
    `decision or missing capability. Warmly and briefly let the user know these are waiting on them and ask ` +
    `them to weigh in:\n${list}\n\n` +
    // The teammate's name is the point of this message: the user's complaint was that they were told a
    // task was blocked but not WHO to go work with. Two deliberate choices in the wording below:
    //  (1) no example agent name — an example would be a hardcoded display name in a prompt, and the
    //      model tends to echo whichever name it is shown;
    //  (2) the rejected label-style forms are described, never quoted — naming them verbatim primes the
    //      model to reproduce the exact phrasing we are trying to avoid.
    `Where a teammate is named on an item above, work their name into the sentence the way a person would ` +
    `speak it — that teammate needs the user on that item — so they know who to go work with. Keep it ` +
    `conversational prose; do not restate it as a metadata label or an attribution tag. Where no teammate ` +
    `is named, simply say that item is waiting on their input: do not guess at a name, and do not refer to ` +
    `"the team" as though it were a person.\n\n` +
    `This is a REPORT-ONLY turn: do not call any tool, and keep it short.`;
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
  opts: { timeZone?: string; force?: boolean; runId?: string; promoteOnly?: boolean; armOnly?: boolean } = {},
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
  } = await import("./tasks.server");
  const { listArtifacts } = await import("../artifacts/artifacts.server");
  const { enqueueTurn } = await import("./turns.server");
  const { isStructuredWorkflowRequired } = await import("../identity/agent-workflow-config.server");

  // Every open, assigned, unblocked task regardless of its current stage (BACKLOG..IN_REVIEW) — bucketed
  // per agent below. Already ordered by priority_rank, so backlog/up-next slices stay priority-ordered.
  // PARKING LOT: a task tagged `parking-lot` opts OUT of all automation — it is filtered here at
  // candidate-selection time, so it is never promoted (BACKLOG→UP_NEXT→DOING) and never enqueues a work
  // turn. It stays on the board (typically Backlog) with the tag until the user un-parks it. (ACT-13.)
  // REMINDER WINDOW: same treatment as parking-lot. A `reminder`-tagged task with a scheduled, unfired
  // reminder has already had its decision made by the user — it must not be re-promoted, re-asked, or
  // enqueued for work while it waits. It re-enters candidate selection when the reminder fires.
  const { taskIdsInReminderWindow } = await import("./turns.server");
  const inReminderWindow = await taskIdsInReminderWindow(email);
  const assigned = (await getOpenAssignedTasks(email)).filter(
    (t) => !(t.tags ?? []).includes("parking-lot") && !inReminderWindow.has(t.id),
  );
  const signature = backlogSignature(assigned);

  if (!assigned.length && !opts.force) {
    if (opts.armOnly) return { ok: true, skipped: true, reason: "empty", enqueued: 0, promoted: 0, blocked: 0, remaining: 0, runId };
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
  // That sentence used to describe the spec while the code did the opposite: only upNextAfterTopUp[0] was ever
  // evaluated, so an unanswered ask on top blocked a confirmed + approved item behind it forever
  // (scripts/autowork-lane-starvation.test.ts case A, 2026-10-20). Now the WHOLE lane is evaluated and the first
  // READY item in lane order starts, wherever it sits (AC-1, AC-11).
  const promotions: { task_id: string; status: string }[] = [];
  // Each agent's ASK lane (its unconfirmed DOING item + every Up Next item after top-up) — what the confirm-ask
  // rotation arms over. Built for EVERY agent, review-frozen or not: owner 2026-10-27, asks keep looping while
  // review is full; only promotion to DOING waits for the user to clear review.
  const lanes: { agent: string; lane: BoardTaskRow[] }[] = [];
  // freshPromotion=false candidates are tasks ALREADY sitting in DOING (however they got there — a
  // normal earlier promotion, or a race/stale-mirror read that skipped the gate entirely, as happened
  // 2026-08-05: a task reached DOING and completed to IN_REVIEW without ever confirming intent). They
  // must pass the SAME confirm-intent check as a fresh UP_NEXT->DOING promotion before they're eligible
  // for a new research turn — closing that gap regardless of how a task lands in DOING.
  type Candidate = { agent: string; task: BoardTaskRow; freshPromotion: boolean };
  const doingSlotCandidates: Candidate[] = [];
  // Agents whose DOING slot is open (and who aren't review-frozen) this pass, with their whole Up Next lane in
  // lane order — any READY item in it may start.
  const laneCandidates: { agent: string; tasks: BoardTaskRow[] }[] = [];
  const doingCandidates: BoardTaskRow[] = [];
  for (const [agent, bucket] of byAgent.entries()) {
    for (const t of bucket.doing.slice(0, DOING_CAP)) {
      doingSlotCandidates.push({ agent, task: t, freshPromotion: false });
    }
    const frozen = bucket.inReview.length >= REVIEW_CAP;
    // armOnly writes nothing, so it must not plan a top-up it will never make (or arm asks for backlog items).
    const room = frozen || opts.armOnly ? 0 : Math.max(0, UP_NEXT_CAP - bucket.upNext.length);
    const toPromote = bucket.backlog.slice(0, room);
    for (const t of toPromote) promotions.push({ task_id: t.id, status: "UP_NEXT" });
    const upNextAfterTopUp = [...bucket.upNext, ...toPromote];
    lanes.push({ agent, lane: askLane(bucket.doing, upNextAfterTopUp) });
    if (!frozen && bucket.doing.length < DOING_CAP && upNextAfterTopUp.length) {
      laneCandidates.push({ agent, tasks: upNextAfterTopUp });
    }
  }
  // Every id the gate or the ask rotation needs — read in ONE query per pass, never per item (AC-19).
  const gateIds = [
    ...new Set([...doingSlotCandidates.map((c) => c.task.id), ...lanes.flatMap((l) => l.lane.map((t) => t.id))]),
  ];

  // Per-agent gate requirement. FAIL-CLOSED twice over: a resolver that THROWS (or resolves to anything but an
  // explicit `false`) counts as REQUIRED, so a config hiccup can never treat a task as ungated — and one
  // agent's failure can no longer reject the whole Promise.all and throw the pass (AC-13).
  const resolveRequired = async (): Promise<Map<string, boolean>> =>
    new Map(
      await Promise.all(
        [...new Set(lanes.map((l) => l.agent))].map(async (a): Promise<[string, boolean]> => {
          try {
            return [a, (await isStructuredWorkflowRequired(email, a)) !== false];
          } catch {
            return [a, true];
          }
        }),
      ),
    );

  const { resolveConfirmFanWindows, CONFIRM_FAN_WINDOWS_DEFAULT, resolveConfirmReaskMinHours, CONFIRM_REASK_MIN_HOURS_DEFAULT } =
    await import("../identity/scheduling-config.server");
  // The per-ITEM re-ask floor (owner: 24h). A non-positive / non-numeric value falls back to the default —
  // never to "re-ask every gap".
  let reaskMinHours = CONFIRM_REASK_MIN_HOURS_DEFAULT;
  try {
    const h = await resolveConfirmReaskMinHours(email);
    if (Number.isFinite(h) && h > 0) reaskMinHours = h;
  } catch {
    /* default floor */
  }
  const reaskMinMs = reaskMinHours * 3_600_000;

  // Put this pass's asks on the spacing chain: first asks for never-asked lane items, and at most one re-ask
  // per agent for its least-recently-asked unanswered item (planConfirmArming holds the rotation rules). This
  // only SCHEDULES — fireDueConfirmAsks (heartbeat) is the only sender.
  const armLanes = async (states: Map<string, EngagementLike>, required: Map<string, boolean>) => {
    let windows = CONFIRM_FAN_WINDOWS_DEFAULT;
    try {
      windows = await resolveConfirmFanWindows(email);
    } catch {
      /* default windows */
    }
    const plan = planConfirmArming({ lanes, states, required, now: Date.now(), reaskMinMs });
    await armConfirmAsksSpaced(plan, email, tz, windows);
  };

  // armOnly (the heartbeat, right after it SENDS an ask): ONLY put the next asks on the spacing chain — no top-up,
  // no promotion, no research turn, no signature write. Without this, a re-ask was re-armed only at the 9/13/17
  // passes, and with one queued re-ask per agent that capped each agent at 3 re-asks a day on top of the 45–90 min
  // spacing — a second cap the owner ruled out (2026-10-27, "no double capping"; VERIFY-confirm-ask-rotation-1).
  if (opts.armOnly) {
    if (lanes.length) {
      try {
        await armLanes(await getTaskEngagementStates(gateIds), await resolveRequired());
      } catch {
        /* best-effort — the next send or cadence pass re-arms */
      }
    }
    return { ok: true, skipped: false, reason: "arm_only", enqueued: 0, promoted: 0, blocked: 0, remaining: 0, runId };
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
    // Chain the confirm-intent REACH-OUT scheduling to grooming completion: arm each lane item's ONE-TIME
    // `confirm_ask_at` (and any due re-ask), sequenced a randomized 45–90 min gap apart inside the fan-out
    // windows, for gated agents. This SCHEDULES the reach-out relative to grooming; the heartbeat
    // (fireDueConfirmAsks) is what FIRES each ask once its instant passes. No ask is fired and no work starts
    // here (that stays behind the gate).
    if (lanes.length) {
      try {
        await armLanes(await getTaskEngagementStates(gateIds), await resolveRequired());
      } catch {
        /* arming is best-effort — the next full cadence pass still schedules any un-armed asks */
      }
    }
    await setAutoWorkSignature(email, signature);
    return { ok: true, skipped: false, reason: "promote_only", enqueued: 0, promoted, blocked: 0, remaining: 0, runId };
  }

  const engagementByTaskId = await getTaskEngagementStates(gateIds);
  const requiredByAgent = await resolveRequired();

  // READY = may start real work: the gate is satisfied (confirmed DoD + APPROVED approach — 'pending' means the
  // agent hasn't proposed one yet, 'escalated' means its cap was exhausted and the owner-override flow owns it;
  // neither is promoted) AND no open clarifying question (that pauses a task whether or not it is gated).
  // `?? true`: an agent missing from the map defaults to REQUIRED (fail-closed).
  const isReady = (agent: string, task: BoardTaskRow): boolean => {
    const state = engagementByTaskId.get(task.id);
    if (state?.clarify_status === "open") return false;
    if (!(requiredByAgent.get(agent) ?? true)) return true;
    return state?.confirm_status === "confirmed" && state?.approach_status === "approved";
  };
  for (const c of doingSlotCandidates) {
    if (isReady(c.agent, c.task)) doingCandidates.push(c.task);
  }
  for (const { agent, tasks } of laneCandidates) {
    // The FIRST ready item in lane order — one per agent, so DOING_CAP holds (AC-4).
    const ready = tasks.find((t) => isReady(agent, t));
    if (ready) {
      promotions.push({ task_id: ready.id, status: "DOING" });
      doingCandidates.push(ready);
    }
  }

  try {
    await armLanes(engagementByTaskId, requiredByAgent);
  } catch {
    /* arming is best-effort — retried next pass */
  }

  // Approach RE-DRIVE (F10, AC-34/35): a lane item whose DoD the user confirmed but whose approach is still
  // 'pending' was never proposed (the confirm turn didn't reach propose_approach), and nothing else ever asks
  // again. Nudge the agent with an internal turn — no phone push, the user is not re-asked — no sooner than the
  // per-item floor after the last nudge (or the confirmation), at most WorkflowCaps.approach times; after that
  // it follows the existing escalation (approach_status='escalated', owner-override flow). 'escalated' items
  // are never nudged (AC-36).
  {
    const redrives: { agent: string; task: BoardTaskRow }[] = [];
    for (const { agent, lane } of lanes) {
      if (!(requiredByAgent.get(agent) ?? true)) continue;
      for (const t of lane) {
        const s = engagementByTaskId.get(t.id);
        if (s?.confirm_status === "confirmed" && s.approach_status === "pending" && s.clarify_status !== "open") {
          redrives.push({ agent, task: t });
        }
      }
    }
    if (redrives.length) {
      const { getWorkflowCaps } = await import("../identity/agent-workflow-config.server");
      const { claimApproachRedrive, releaseApproachRedrive, escalateApproach } = await import("./tasks.server");
      const nowMs = Date.now();
      for (const { agent, task } of redrives) {
        try {
          const s = engagementByTaskId.get(task.id)!;
          const caps = await getWorkflowCaps(email, agent);
          const n = s.approach_redrive_count ?? 0;
          // Floor first: the agent gets the same full window after its LAST nudge before it is escalated.
          const since = ms(s.approach_redrive_last_at) ?? ms(s.confirmed_at);
          if (since !== null && nowMs - since < reaskMinMs) continue;
          if (n >= caps.approach) {
            await escalateApproach(task.id, email);
            continue;
          }
          const claimed = await claimApproachRedrive(task.id, n);
          if (claimed === null) continue;
          let ok = false;
          try {
            ok = await enqueueTurn(
              `autowork-approach-${task.id}-${claimed}-${runId}`,
              `dm-${agent}`,
              email,
              turnPayload({ assigned_agent: agent }, approachRedriveDirective(task), tz, caller),
            );
          } catch {
            ok = false;
          }
          if (!ok) {
            const prev = ms(s.approach_redrive_last_at);
            await releaseApproachRedrive(task.id, claimed, prev === null ? null : new Date(prev).toISOString()).catch(() => {});
          }
        } catch {
          /* one bad re-drive never blocks the rest */
        }
      }
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
  const blockedItems: BlockedItem[] = board
    .filter((t) => !t.completed_at && blockers.has(t.id))
    .map((t) => {
      const b = blockers.get(t.id);
      // WHICH person do we name? Deliberately the ASSIGNEE (`t.assigned_agent`), NOT the blocker row's
      // own `agentId` (the agent that FLAGGED it). The sentence we generate is "X needs you on this" —
      // that is true of whoever cannot proceed with the task, i.e. its owner. The flagger may be a
      // different agent who merely noticed the block, and naming them would send the user to the wrong
      // teammate with full confidence. No fallback to the flagger for the same reason: an ownerless item
      // renders ownerless (see the `who` branch in surfaceBlocked) rather than confidently wrong.
      // blockedOwnerName() is undefined for BOTH a null assignee and an unknown/stale id, so a slug
      // can never leak into the sentence as if it were a human name.
      return { title: t.title, reason: b?.reason, ownerName: blockedOwnerName(t.assigned_agent) };
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

  if (blockedItems.length) {
    try {
      await surfaceBlocked({ email, tz, caller, items: blockedItems, runId });
    } catch {
      /* non-fatal */
    }
  }

  await setAutoWorkSignature(email, signature);
  const remaining = Math.max(0, candidates.length - enqueued);
  return { ok: true, skipped: false, enqueued, promoted, blocked: blockedItems.length, remaining, confirmAsked: 0, runId };
}
