// Scrum ceremonies (stand-up, retro, sprint planning, sprint review), grounded in the
// Azure-PG task mirror so agents report REAL progress and blockers, never improvised ones.
//
// Two run modes (chosen by the router's ceremonyMode):
//  - "round-robin" (default): each lane owner voices their own section from THEIR lane's
//    real tasks; Terry (scrum master) closes and reports blockers to the user.
//  - "narrate": Terry runs the whole thing solo from the same data.
//
// All four ceremonies read the same mirror; they differ only in window + framing. The data
// bucketing (done / up-next / blocked / overdue) is shared.

import { AGENTS, type AgentId } from "../../data/agents";
import type { StandupTask } from "./tasks.server";

const AGENT_IDS = new Set<string>(AGENTS.map((a) => a.id));

export type CeremonyType = "standup" | "retro" | "planning" | "review";

// Journey task category → the agent who owns that lane. Falls back to the team lead
// (coordinator) for anything unmapped, so every task lands with an owner.
const CATEGORY_OWNER: Record<string, AgentId> = {
  VENTURES: "sam-trent",
  CAREER: "cole-blake",
  PROF_EDUCATION: "elle-rowan",
  EDUCATION: "elle-rowan",
  PRODUCT: "tess-sutton",
  FINANCE: "finn-reid",
  FAMILY: "faith-hartley",
  LIFE: "iris-chase",
};
const FALLBACK_OWNER: AgentId = "iris-chase";
const CEREMONY_HOST: AgentId = "terry-locke";

export function ownerForCategory(category: string | null): AgentId {
  if (!category) return FALLBACK_OWNER;
  return CATEGORY_OWNER[category.toUpperCase()] ?? FALLBACK_OWNER;
}

// Who owns a task in a ceremony: the scrum-master's explicit assignment wins (Jira-style
// swimlane-by-assignee); unassigned tasks fall back to the lane/category owner.
export function ownerForTask(t: Pick<StandupTask, "assigned_agent" | "category">): AgentId {
  if (t.assigned_agent && AGENT_IDS.has(t.assigned_agent)) return t.assigned_agent as AgentId;
  return ownerForCategory(t.category);
}

export const CEREMONY_WINDOW_HOURS: Record<CeremonyType, number> = {
  standup: 36, // since yesterday
  retro: 336, // ~2 weeks (a sprint)
  planning: 720, // ~30 days of backlog to plan from
  review: 336, // what shipped this sprint
};

export interface TaskLine {
  title: string;
  priority: string | null;
  due_date: string | null;
}
export interface BlockedLine extends TaskLine {
  why: string;
}
export interface LaneReport {
  category: string;
  owner: AgentId;
  done: TaskLine[];
  upNext: TaskLine[];
  blocked: BlockedLine[];
  overdue: TaskLine[];
}
export interface CeremonyReport {
  type: CeremonyType;
  windowHours: number;
  lanes: LaneReport[];
  blockers: (BlockedLine & { category: string; owner: AgentId })[];
  counts: { done: number; upNext: number; blocked: number; overdue: number };
}

const line = (t: StandupTask): TaskLine => ({ title: t.title, priority: t.priority, due_date: t.due_date });

/** Bucket the mirror tasks into per-lane done / up-next / blocked / overdue. Shared by all ceremonies. */
export function buildCeremonyReport(type: CeremonyType, tasks: StandupTask[]): CeremonyReport {
  const now = Date.now();
  // Group by OWNER (assignee-first, category fallback) so each agent gets one lane = their queue.
  const byOwner = new Map<AgentId, LaneReport>();
  const laneFor = (t: StandupTask): LaneReport => {
    const owner = ownerForTask(t);
    let lane = byOwner.get(owner);
    if (!lane) {
      lane = { category: (t.category ?? "GENERAL").toUpperCase(), owner, done: [], upNext: [], blocked: [], overdue: [] };
      byOwner.set(owner, lane);
    }
    return lane;
  };

  for (const t of tasks) {
    const lane = laneFor(t);
    if (t.completed_at) {
      lane.done.push(line(t));
    } else if (t.status === "BLOCKED" || (t.pushed_count ?? 0) >= 3) {
      const why = t.status === "BLOCKED" ? "marked blocked" : `deferred ${t.pushed_count}×`;
      lane.blocked.push({ ...line(t), why });
    } else if (t.due_date && new Date(t.due_date).getTime() < now) {
      lane.overdue.push(line(t));
    } else {
      lane.upNext.push(line(t));
    }
  }

  const lanes = [...byOwner.values()].filter(
    (l) => l.done.length || l.upNext.length || l.blocked.length || l.overdue.length,
  );
  const blockers = lanes.flatMap((l) => l.blocked.map((b) => ({ ...b, category: l.category, owner: l.owner })));
  const counts = {
    done: lanes.reduce((n, l) => n + l.done.length, 0),
    upNext: lanes.reduce((n, l) => n + l.upNext.length, 0),
    blocked: lanes.reduce((n, l) => n + l.blocked.length, 0),
    overdue: lanes.reduce((n, l) => n + l.overdue.length, 0),
  };
  return { type, windowHours: CEREMONY_WINDOW_HOURS[type], lanes, blockers, counts };
}

const CEREMONY_WORDS: { type: CeremonyType; re: RegExp }[] = [
  { type: "planning", re: /\b(sprint planning|plan (the|our|this|next) sprint|planning session|plan the week)\b/i },
  { type: "review", re: /\b(sprint review|review the sprint|sprint demo|what did we ship)\b/i },
  { type: "retro", re: /\b(retro|retrospective|post[- ]?mortem|what went well)\b/i },
  {
    type: "standup",
    re: /\b(stand[- ]?up|standup|daily (scrum|check[- ]?in|sync|huddle)|morning (check[- ]?in|sync|huddle|standup)|run the daily|round[- ]?robin (update|report))\b/i,
  },
];

/** Detect a ceremony request from the user's message; null if none. */
export function detectCeremony(text: string): CeremonyType | null {
  for (const { type, re } of CEREMONY_WORDS) if (re.test(text)) return type;
  return null;
}

const VERB: Record<CeremonyType, string> = {
  standup: "daily stand-up",
  retro: "sprint retrospective",
  planning: "sprint planning",
  review: "sprint review",
};

// due_date comes off the pg mirror as a Date (timestamptz), not a string — coerce safely.
function fmtDate(v: string | Date | null): string {
  if (!v) return "";
  const iso = typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v);
  return iso.slice(0, 10);
}
function fmtLines(items: TaskLine[], max = 6): string {
  if (!items.length) return "none";
  return items
    .slice(0, max)
    .map((t) => `“${t.title}”${t.due_date ? ` (due ${fmtDate(t.due_date)})` : ""}${t.priority ? ` [${t.priority}]` : ""}`)
    .join("; ");
}
function fmtBlocked(items: BlockedLine[], max = 6): string {
  if (!items.length) return "none";
  return items.slice(0, max).map((b) => `“${b.title}” (${b.why})`).join("; ");
}

/**
 * The grounded facts for ONE lane owner's turn in a round-robin. The owner must speak only
 * from this; if their lane is empty they say so briefly.
 */
export function ownerDirective(type: CeremonyType, lane: LaneReport): string {
  const frame =
    type === "standup"
      ? "Give your stand-up update for your lane: what moved (done), what's next, and anything blocked. 1–2 sentences, conversational."
      : type === "retro"
        ? "Give your retro read for your lane: what shipped, what stalled or got blocked, what slipped. 1–2 sentences."
        : type === "planning"
          ? "Propose what to take on next in your lane from the up-next/overdue items, hardest-or-soonest first. 1–2 sentences."
          : "Report what your lane delivered (the done items) — demo-ready wins. 1–2 sentences.";
  return `\n\nCEREMONY — the scrum master has OPENED this live ${VERB[type]} and handed off to the team; give YOUR lane's update in the round-robin. ${frame} Use ONLY these real facts about your lane (${lane.category}); do NOT invent tasks, and do NOT comment on other lanes:
- done: ${fmtLines(lane.done)}
- up next: ${fmtLines(lane.upNext)}
- overdue: ${fmtLines(lane.overdue)}
- blocked: ${fmtBlocked(lane.blocked)}
You MUST name the actual items in every bucket that is not "none" — do not summarize them away or skip them. Only if done, up next, overdue AND blocked are all "none" may you say you have nothing to report.`;
}

function reportDigest(report: CeremonyReport): string {
  const laneLines = report.lanes
    .map(
      (l) =>
        `- ${l.category} (@${l.owner}): done ${l.done.length}, next ${l.upNext.length}, overdue ${l.overdue.length}, blocked ${l.blocked.length}`,
    )
    .join("\n");
  const blockerLines = report.blockers.length
    ? report.blockers.map((b) => `- ${b.category}: “${b.title}” (${b.why})`).join("\n")
    : "- none";
  return `Lanes:\n${laneLines || "- (no activity)"}\n\nBlockers needing the user:\n${blockerLines}`;
}

/** Terry's OPENING turn: he goes first — greets, frames the ceremony, surfaces the blockers that
 *  need the user, then hands off to the lane owners. (Users expect the scrum master to open a
 *  stand-up and pass it along, not for a lane owner to just start talking.) */
export function openerDirective(
  type: CeremonyType,
  report: CeremonyReport,
  handoffNames: string[] = [],
): string {
  const open =
    type === "standup"
      ? "Open the stand-up: greet the team in one line, give a one-sentence read of where things stand, call out any blockers that need the user's decision (or say there are none), then hand off to the lane owners to give their updates."
      : type === "retro"
        ? "Open the retro: greet the team, frame the sprint in one line, then hand off to each lane owner to share what went well and what to improve."
        : type === "planning"
          ? "Open sprint planning: greet the team, note the overall load in one line, then hand off to each lane owner to propose what to take on."
          : "Open the sprint review: greet the team, frame what we set out to ship, then hand off to each lane owner to demo what their lane delivered.";
  // Relay hand-off: the opener MUST pass the ball to the first teammate by name — a real stand-up
  // opens with "Cole, you're up," not a generic "over to the team." Name only the FIRST owner (the
  // immediate hand-off); reciting all nine is unnatural and the model drops it.
  const relay = handoffNames.length ? ` The FIRST teammate to report is ${handoffNames[0]}.` : "";
  const relayClose = handoffNames.length
    ? ` Then your FINAL sentence MUST hand the floor to ${handoffNames[0]} BY NAME — say exactly "${handoffNames[0]}, you're up." Do NOT end the message without that hand-off line.`
    : "";
  return `\n\nCEREMONY — you are the scrum master OPENING this ${VERB[type]}. You go FIRST, before anyone else has spoken. ${open}${relay} Keep the framing to 2–3 short sentences.${relayClose} Use ONLY the real data below; do NOT give the lane updates yourself (each owner will do their own), and do not invent progress.\n\n${reportDigest(report)}`;
}

/** Terry's closing turn after the round-robin: synthesize + surface blockers to the user. */
export function closerDirective(type: CeremonyType, report: CeremonyReport): string {
  const close =
    type === "standup"
      ? "Close the stand-up: one short line on overall state, then list the blockers that need the user's decision (or say there are none)."
      : type === "retro"
        ? "Close the retro: what went well, what to improve, and one or two concrete action items."
        : type === "planning"
          ? "Close planning: propose the sprint — the top few items to commit to across lanes, and flag any overload."
          : "Close the review: summarize what shipped and call out anything not demo-ready.";
  return `\n\nCEREMONY — you are the scrum master CLOSING this ${VERB[type]}. The team has ALREADY given their updates — do NOT open the ceremony, do NOT ask anyone for updates, and do NOT say "let's begin" or "please share". Your only job now is to close it. ${close} Use ONLY the real data below; do not invent progress. Keep it tight.\n\n${reportDigest(report)}`;
}

/** A user BARGE-IN mid-ceremony: the addressed agent pauses the round-robin, answers the
 *  interjection directly (or acts on it — e.g. files a task), then the relay resumes. Type-agnostic
 *  so it works on a resumed chunk where the ceremony type isn't re-derived. */
export function bargeDirective(text: string): string {
  return `\n\nThe user just INTERJECTED during this live ceremony and said: "${text}". Pause and address them directly RIGHT NOW — answer their question, or if they asked to add/track/schedule/change something, use the appropriate tool (e.g. create_huddle_task) to do it and confirm briefly. Keep it to 1–2 sentences. Do NOT give a lane/stand-up update here — the round-robin will resume after you.`;
}

/** Narrate mode: Terry runs the whole ceremony solo from the data. */
export function narrateDirective(type: CeremonyType, report: CeremonyReport): string {
  return `\n\nCEREMONY — you are the scrum master running this ${VERB[type]} SOLO (narrate mode). Deliver it as a brief round-robin yourself: one short line per lane (attribute each to its owner by @handle) covering done/next/blocked, then close with the blockers that need the user's decision. Use ONLY the real data below; do not invent anything.\n\n${reportDigest(report)}`;
}

/** Merge lanes that share an owner (e.g. two categories both owned by the team lead). */
export function lanesByOwner(report: CeremonyReport): Map<AgentId, LaneReport> {
  const m = new Map<AgentId, LaneReport>();
  for (const lane of report.lanes) {
    const cur = m.get(lane.owner);
    if (!cur) {
      m.set(lane.owner, {
        category: lane.category,
        owner: lane.owner,
        done: [...lane.done],
        upNext: [...lane.upNext],
        blocked: [...lane.blocked],
        overdue: [...lane.overdue],
      });
    } else {
      cur.category += `/${lane.category}`;
      cur.done.push(...lane.done);
      cur.upNext.push(...lane.upNext);
      cur.blocked.push(...lane.blocked);
      cur.overdue.push(...lane.overdue);
    }
  }
  return m;
}

/** Ordered participants for a round-robin: the HOST OPENS (goes first), then each lane owner with
 *  activity gives their update. The scrum master framing the meeting and handing off is what users
 *  expect — not a lane owner abruptly starting. */
export function roundRobinParticipants(report: CeremonyReport, members: AgentId[]): AgentId[] {
  const owners: AgentId[] = [];
  for (const lane of report.lanes) {
    if (!owners.includes(lane.owner) && members.includes(lane.owner)) owners.push(lane.owner);
  }
  const host = members.includes(CEREMONY_HOST) ? [CEREMONY_HOST] : [];
  // Host first (opener); lane owners follow. Host is de-duped from the owners list so it speaks once.
  return [...host, ...owners.filter((o) => o !== CEREMONY_HOST)];
}

export { CEREMONY_HOST };
