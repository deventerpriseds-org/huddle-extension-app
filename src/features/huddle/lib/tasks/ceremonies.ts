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

// The completed-within window per ceremony. This is BOTH the fetch window (getStandupTasks) AND the
// DONE report window (buildCeremonyReport) — same number so they can never desync. Stand-up = "this
// week" (7d), the user's interim rule (was 36h); the others keep their sprint horizons.
export const CEREMONY_WINDOW_HOURS: Record<CeremonyType, number> = {
  standup: 168, // "this week" (7 days) — DONE reported since ~a week ago
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
// Per-owner lane report, bucketed by the task's REAL board status column (never re-derived). Mirrors
// the board's columns 1:1 so the stand-up says exactly what the board shows.
export interface LaneReport {
  category: string;
  owner: AgentId;
  upNext: TaskLine[];
  doing: TaskLine[];
  inReview: TaskLine[];
  blocked: BlockedLine[];
  done: TaskLine[];
  backlog: TaskLine[];
}
export interface CeremonyReport {
  type: CeremonyType;
  windowHours: number;
  lanes: LaneReport[];
  blockers: (BlockedLine & { category: string; owner: AgentId })[];
  counts: { upNext: number; doing: number; inReview: number; blocked: number; done: number; backlog: number };
}

const line = (t: StandupTask): TaskLine => ({ title: t.title, priority: t.priority, due_date: t.due_date });

// SERVER-SIDE mirror of BoardView.tsx's status→column mapping — the single source of "which board lane
// a task is in." Keep in sync with COLUMNS in BoardView.tsx. The ceremony reports by THIS, so a task
// never appears in a lane different from where the board shows it (no re-deriving from open-ness/due).
export type BoardLane = "backlog" | "upNext" | "doing" | "inReview" | "blocked" | "done";
export function boardLaneFor(status: string | null): BoardLane {
  const s = (status ?? "").toUpperCase();
  if (s === "UP_NEXT" || s === "READY") return "upNext";
  if (s === "DOING") return "doing";
  if (s === "IN_REVIEW") return "inReview";
  if (s === "BLOCKED") return "blocked";
  if (s === "DONE") return "done";
  return "backlog"; // BACKLOG / TODO / PLANNING / null — the raw holding area
}

// Which board lanes each ceremony SURFACES. Bucketing is ALWAYS by real status; this only selects what
// gets reported. Stand-up = the active board (WIP) + recent done — NEVER the raw backlog (grows to 100s).
const CEREMONY_LANES: Record<CeremonyType, BoardLane[]> = {
  standup: ["blocked", "doing", "upNext", "inReview", "done"],
  review: ["done", "inReview", "blocked"], // what shipped / is ready
  retro: ["done", "inReview", "blocked", "doing"], // what happened this sprint
  planning: ["backlog", "upNext", "blocked"], // plan FROM the backlog (the one ceremony that needs it)
};

// Which board lanes earn an agent a LIVE SPEAKING SLOT in the round-robin (F9). This is a SUBSET of
// CEREMONY_LANES: a lane can be REPORTABLE (its items show in the host's digest/counts) without warranting
// its owner a live turn. For the STAND-UP, RESOLVED F9.4 fixes the keep-set to
// {blocked, doing, upNext, inReview} — a stand-up is about forward-looking work + blockers, so a lane whose
// ONLY items are DONE-this-week is NOT a speaking slot (its done still surfaces in the host's opener/close
// via reportDigest). BLOCKED explicitly KEEPS the slot (blocked is real news the user must hear).
// For every OTHER ceremony the slot-set == CEREMONY_LANES (a review/retro EXISTS to voice done items, so
// done must earn a slot there). Data-driven: adding an agent needs zero change; adding a ceremony type
// adds one entry here alongside CEREMONY_LANES.
const CEREMONY_SLOT_LANES: Record<CeremonyType, BoardLane[]> = {
  standup: ["blocked", "doing", "upNext", "inReview"], // F9.4: DONE alone ≠ a live stand-up slot
  review: ["done", "inReview", "blocked"],
  retro: ["done", "inReview", "blocked", "doing"],
  planning: ["backlog", "upNext", "blocked"],
};

/** F9 — does this lane hold work that warrants its owner a LIVE SPEAKING SLOT for this ceremony? True iff
 *  any slot-eligible bucket (CEREMONY_SLOT_LANES) is non-empty. Used by roundRobinParticipants so a
 *  truly-nothing owner (and, for a stand-up, a done-only owner) is never forced into a slot where they'd
 *  invent work — while their DONE items still appear in the host's digest (they stay in report.lanes). */
export function hasSpeakingWork(type: CeremonyType, lane: LaneReport): boolean {
  return CEREMONY_SLOT_LANES[type].some((k) => lane[k].length > 0);
}

/** Bucket the mirror tasks into per-owner lanes BY THEIR REAL BOARD STATUS, then surface only the lanes
 *  this ceremony reports. The stand-up thus reflects the board exactly — active WIP + done-this-week,
 *  never the raw backlog, and never a re-derived "up next." */
export function buildCeremonyReport(type: CeremonyType, tasks: StandupTask[]): CeremonyReport {
  const now = Date.now();
  // DONE report window == the fetch window (same number → can't desync). Stand-up = 7d ("this week").
  const doneWindowMs = CEREMONY_WINDOW_HOURS[type] * 60 * 60 * 1000;
  const byOwner = new Map<AgentId, LaneReport>();
  const laneReport = (t: StandupTask): LaneReport => {
    const owner = ownerForTask(t);
    let lr = byOwner.get(owner);
    if (!lr) {
      lr = { category: (t.category ?? "GENERAL").toUpperCase(), owner, upNext: [], doing: [], inReview: [], blocked: [], done: [], backlog: [] };
      byOwner.set(owner, lr);
    }
    return lr;
  };

  for (const t of tasks) {
    const bl = boardLaneFor(t.status);
    // DONE is windowed to "this week" — a card finished long ago is not stand-up news.
    if (bl === "done") {
      // Report a DONE card only if it was completed within the window. completed_at is the truth;
      // fall back to updated_at if it's missing; if BOTH are absent we can't prove recency → exclude.
      const doneAtRaw = t.completed_at ?? t.updated_at;
      const doneAt = doneAtRaw ? new Date(doneAtRaw).getTime() : 0;
      if (!doneAt || now - doneAt > doneWindowMs) continue;
    }
    const lr = laneReport(t);
    if (bl === "blocked") lr.blocked.push({ ...line(t), why: "marked blocked" });
    else lr[bl].push(line(t));
  }

  // Surface only the lanes this ceremony reports; drop owners with nothing reportable.
  const surface = new Set<BoardLane>(CEREMONY_LANES[type]);
  const reportable = (l: LaneReport): number =>
    (["upNext", "doing", "inReview", "done", "backlog"] as const).reduce(
      (n, k) => n + (surface.has(k) ? l[k].length : 0),
      surface.has("blocked") ? l.blocked.length : 0,
    );
  const lanes = [...byOwner.values()].filter((l) => reportable(l) > 0);
  const blockers = surface.has("blocked")
    ? lanes.flatMap((l) => l.blocked.map((b) => ({ ...b, category: l.category, owner: l.owner })))
    : [];
  const counts = {
    upNext: lanes.reduce((n, l) => n + l.upNext.length, 0),
    doing: lanes.reduce((n, l) => n + l.doing.length, 0),
    inReview: lanes.reduce((n, l) => n + l.inReview.length, 0),
    blocked: lanes.reduce((n, l) => n + l.blocked.length, 0),
    done: lanes.reduce((n, l) => n + l.done.length, 0),
    backlog: lanes.reduce((n, l) => n + l.backlog.length, 0),
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
    .map((t) => `"${t.title}"${t.due_date ? ` (due ${fmtDate(t.due_date)})` : ""}${t.priority ? ` [${t.priority}]` : ""}`)
    .join("; ");
}
function fmtBlocked(items: BlockedLine[], max = 6): string {
  if (!items.length) return "none";
  return items.slice(0, max).map((b) => `"${b.title}" (${b.why})`).join("; ");
}

/**
 * The grounded facts for ONE lane owner's turn in a round-robin. The owner must speak only
 * from this; if their lane is empty they say so briefly.
 */
export function ownerDirective(type: CeremonyType, lane: LaneReport): string {
  const frame =
    type === "standup"
      ? "Give your stand-up update for your lane: what you're doing now, what's up next, anything in review, and anything blocked. 1–2 sentences, conversational."
      : type === "retro"
        ? "Give your retro read for your lane: what shipped, what stalled or got blocked. 1–2 sentences."
        : type === "planning"
          ? "Propose what to take on next in your lane from the backlog/up-next items, hardest-or-soonest first. 1–2 sentences."
          : "Report what your lane delivered (the done items) — demo-ready wins. 1–2 sentences.";
  // Facts drawn from the board's REAL lanes — only the lanes this ceremony reports (CEREMONY_LANES).
  const surface = new Set<BoardLane>(CEREMONY_LANES[type]);
  const facts: string[] = [];
  if (surface.has("doing")) facts.push(`Doing: ${fmtLines(lane.doing)}`);
  if (surface.has("upNext")) facts.push(`Up next: ${fmtLines(lane.upNext)}`);
  if (surface.has("inReview")) facts.push(`In review: ${fmtLines(lane.inReview)}`);
  if (surface.has("blocked")) facts.push(`Blocked: ${fmtBlocked(lane.blocked)}`);
  if (surface.has("done")) facts.push(`Done this week: ${fmtLines(lane.done)}`);
  if (surface.has("backlog")) facts.push(`Backlog: ${fmtLines(lane.backlog)}`);
  return `\n\nCEREMONY — the scrum master has OPENED this live ${VERB[type]} and handed off to the team; give YOUR lane's update in the round-robin. ${frame} You MAY briefly acknowledge or react to the previous speaker (a sentence, not a debate) before your own update — like a real teammate would — but the substance must be YOUR lane's facts; do not take over or re-report another lane's work. Use ONLY these real facts about your lane (${lane.category}); do NOT invent tasks. ${facts.join(". ")}.
You MUST name the actual items in every bucket that is not "none" — do not summarize them away or skip them. Only if every bucket above is "none" may you say you have nothing to report. Weave all of this into 1–2 natural spoken sentences, the way you'd actually talk in a stand-up — never echo this back as a bulleted or labeled list (no "Doing:"/"Up next:"/"In review:"/"Blocked:"/"Done:" headers, no line breaks between categories); that's the raw data, not a template to repeat.
This is a STATUS REPORT, not a working session. Report your lane's facts and STOP — even if your ROLE normally asks the user questions, requests an upload, gathers requirements, or builds something (a plan, a schedule, a draft), do NOT do any of that here, and do NOT ask the user anything. If your ONLY item is a blocker (nothing doing, up next, or in review), simply state that you're blocked on it and, in the SAME sentence, what you need to unblock — do NOT fill the gap by interrogating the user or kicking off a side task. Any actual planning or Q&A happens later, outside the round-robin.
End with YOUR OWN update and STOP. The scrum master runs the running order and will bring in whoever is next — so do NOT call on, hand the floor to, or name who goes next: no "over to you, <name>", no "how about you, <name>?", no "you're up, <name>". Naming or picking the next speaker is never your job here, and the person you'd name may not even be in this round-robin.`;
}

function reportDigest(report: CeremonyReport): string {
  const laneLines = report.lanes
    .map(
      (l) =>
        `- ${l.category} (@${l.owner}): doing ${l.doing.length}, next ${l.upNext.length}, review ${l.inReview.length}, blocked ${l.blocked.length}, done ${l.done.length}`,
    )
    .join("\n");
  const blockerLines = report.blockers.length
    ? report.blockers.map((b) => `- ${b.category}: "${b.title}" (${b.why})`).join("\n")
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
  return `\n\nThe user just INTERJECTED during this live ceremony and said: "${text}". They cut in on purpose — HEAR them and respond to THIS specifically, not a script.

FIRST decide which of these it is:
- BARE HAIL (they only called your name with no request yet — e.g. just "Hey Sam", "Sam?", "you there?") → reply with ONE short ready acknowledgment ("Yes?—go ahead.") and STOP. Do not guess a task, do not act. Wait for their actual request. A content-free "yes?" is acceptable ONLY in this bare-hail case.
- A REAL request (a question, or a change/add/track/schedule/status command) → open with a brief acknowledgment that NAMES the specific thing they asked about — say the actual subject back ("the investor pitch", "the Nexus item"), e.g. "No problem — parking the investor pitch now." NEVER a generic "got it, on it" / "I'll dig into that" that could apply to anything: that does not prove you heard THEM and is exactly the wrong response. Then in the same breath do exactly what they asked:
  - A question (including about what you were just saying, e.g. "what are you looking into?" / "dig into what?", or "more detail on that") → ANSWER it directly from the current context. You JUST walked the board in this very stand-up, so if the answer is already known (e.g. you named a blocker moments ago, or it's in the update in front of you), STATE IT PLAINLY AND SPECIFICALLY NOW — name the actual task/blocker/status. Do NOT deflect a question you can already answer with "I'll follow up after the stand-up"; that deferral is ONLY for when you genuinely had to run a tool that hasn't returned yet (next paragraph), never for something you already know.
  - A change/add/track/schedule/status request (e.g. "mark the investor pitch done", "park that item", "add a task") → actually USE the right tool (update_task / create_huddle_task / etc.) to do it, then confirm what you did in board terms.

Resolving "that"/"it": if they refer to "that", "it", "this one", resolve it from what was JUST said in this ceremony and NAME it explicitly in your reply. If genuinely more than one thing could be meant, ask ONE short "which one — the X or the Y?" question instead of guessing. Likewise if the task they NAME matches MORE THAN ONE task (e.g. a lookup returns both "Prepare investor pitch" and "Lock investor pitch"), do NOT just pick one — ask which one before you change anything.

Confirm what you did EXACTLY ONCE — never restate the same confirmation two or three times. Keep it to 1–2 sentences, specific to THEIR words. NEVER reply with a stock filler or a canned deferral like "I'll dig into that" / "I'll take care of it after we wrap" — that ignores what they said. Do NOT resume your lane/stand-up update here; the round-robin resumes after you.

If you RAN A TOOL (a search, a lookup, a board update) but don't have a finished, speakable answer to give right now, you MUST STILL SAY SOMETHING — never go silent after using a tool. Acknowledge the specific thing they asked about BY NAME and tell them you'll follow up with the result after the stand-up (e.g. "I ran a search on the UPenn AI course — I'll send you the link right after we wrap."). A named acknowledgment + an explicit "I'll follow up after standup" is required; a tool-only turn with no spoken words, or a generic no-subject ack, is never acceptable.

SELF-RECALL — the transcript of THIS stand-up is the source of truth. If they ask what you (or the team) SAID, or "what was that / what's in review / what did you have going", the authoritative answer is what was actually said earlier in THIS ceremony (it is in the conversation above). Read it and answer with that EXACT item — do NOT contradict your own earlier update, and do NOT substitute a different task you pulled from memory. If a memory/search result disagrees with what you said moments ago in this stand-up, the stand-up wins; trust the transcript, not the stale chunk. Only if this ceremony genuinely contains no such statement should you look further — and even then, never invent a stand-up statement you did not make; say plainly you didn't have one rather than fabricating.

ANSWER FROM WHAT YOU KNOW — do NOT run a web search (tavily_web_search) for anything you already know or can read from context: today's or tomorrow's date, the day/time, what you or a teammate just said, a task's status or lane on the board. Those are answered DIRECTLY and instantly ("Today is Wednesday, August 5, 2026.") — you have the date and the board in front of you. tavily_web_search is ONLY for a genuinely EXTERNAL fact you do not have (a public web link, a live external figure). Searching the web for the date, or for something already in this stand-up or on the board, is wrong, slow, and confusing — never do it.`;
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
        upNext: [...lane.upNext],
        doing: [...lane.doing],
        inReview: [...lane.inReview],
        blocked: [...lane.blocked],
        done: [...lane.done],
        backlog: [...lane.backlog],
      });
    } else {
      cur.category += `/${lane.category}`;
      cur.upNext.push(...lane.upNext);
      cur.doing.push(...lane.doing);
      cur.inReview.push(...lane.inReview);
      cur.blocked.push(...lane.blocked);
      cur.done.push(...lane.done);
      cur.backlog.push(...lane.backlog);
    }
  }
  return m;
}

/** Ordered participants for a round-robin: the HOST OPENS (goes first), then each lane owner WITH LIVE
 *  SPEAKING WORK gives their update. The scrum master framing the meeting and handing off is what users
 *  expect — not a lane owner abruptly starting.
 *
 *  F9 — an owner earns a slot ONLY if some slot-eligible bucket is non-empty (hasSpeakingWork). An owner
 *  present in report.lanes but whose only items are DONE-this-week (stand-up) — or no reportable buckets at
 *  all — is dropped from the SPEAKING order; their done still surfaces in the host's digest (they remain in
 *  report.lanes). Aggregated across ALL of an owner's lanes, so an owner with one live lane + one done-only
 *  lane still speaks. The HOST is always included when present (opener/closer) regardless of its own lane —
 *  "host always opens/closes even with no personal items." */
export function roundRobinParticipants(report: CeremonyReport, members: AgentId[]): AgentId[] {
  const speaks = new Set<AgentId>();
  for (const lane of report.lanes) {
    if (members.includes(lane.owner) && hasSpeakingWork(report.type, lane)) speaks.add(lane.owner);
  }
  const owners: AgentId[] = [];
  for (const lane of report.lanes) {
    if (lane.owner !== CEREMONY_HOST && speaks.has(lane.owner) && !owners.includes(lane.owner)) {
      owners.push(lane.owner);
    }
  }
  const host = members.includes(CEREMONY_HOST) ? [CEREMONY_HOST] : [];
  // Host first (opener); lane owners with live work follow, in first-appearance order.
  return [...host, ...owners];
}

export { CEREMONY_HOST };
