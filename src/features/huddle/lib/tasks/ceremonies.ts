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

import type { AgentId } from "../../data/agents";
import type { StandupTask } from "./tasks.server";

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
  const byCat = new Map<string, LaneReport>();
  const laneFor = (category: string | null): LaneReport => {
    const cat = (category ?? "UNCATEGORIZED").toUpperCase();
    let lane = byCat.get(cat);
    if (!lane) {
      lane = { category: cat, owner: ownerForCategory(cat), done: [], upNext: [], blocked: [], overdue: [] };
      byCat.set(cat, lane);
    }
    return lane;
  };

  for (const t of tasks) {
    const lane = laneFor(t.category);
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

  const lanes = [...byCat.values()].filter(
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
  return `\n\nCEREMONY — you are giving YOUR lane's update in a live ${VERB[type]} round-robin (the scrum master will close). ${frame} Use ONLY these real facts about your lane (${lane.category}); do NOT invent tasks, and do NOT comment on other lanes:
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

/** Ordered participants for a round-robin: lane owners with activity, then the host to close. */
export function roundRobinParticipants(report: CeremonyReport, members: AgentId[]): AgentId[] {
  const owners: AgentId[] = [];
  for (const lane of report.lanes) {
    if (!owners.includes(lane.owner) && members.includes(lane.owner)) owners.push(lane.owner);
  }
  const host = members.includes(CEREMONY_HOST) ? [CEREMONY_HOST] : [];
  // Host closes; ensure it's last even if it also owns a lane.
  return [...owners.filter((o) => o !== CEREMONY_HOST), ...host];
}

export { CEREMONY_HOST };
