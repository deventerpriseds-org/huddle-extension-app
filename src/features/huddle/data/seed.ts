import { AGENTS, type AgentId } from "./agents";

export type MessageAuthor =
  | { kind: "user" }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "system" };

export interface HuddleMessage {
  id: string;
  huddleId: string;
  author: MessageAuthor;
  text: string;
  ts: number;
  mentions?: AgentId[];
  replyTo?: string;
  isBriefing?: boolean;
  demo?: boolean;
  checkIn?: {
    kind: "morning" | "midday" | "afternoon" | "adhoc";
    scheduledAt: string;
    host: AgentId;
    joins: AgentId[];
  };
  // Artifacts this agent reply produced — rendered as clickable "Open <name>" chips that open the doc
  // by id in the Artifacts view (fresh SAS minted on open, so the link never expires).
  artifacts?: { id: string; name: string }[];
  // Files the USER attached to THIS message (screenshots, invites, appointments…), uploaded to the
  // artifact blob store first (folder "Uploads", scoped to the addressed agent). Images are shown to
  // the agent via vision; text files are inlined; each renders as a chip on the user's bubble. ACT-45.
  attachments?: { id: string; name: string; mime: string }[];
}

export type HuddleScope = "one-to-one" | "group";

export interface Huddle {
  id: string;
  name: string;
  kind: HuddleScope;
  members: AgentId[]; // agents present (user is implicit)
  topic?: string;
  demo?: boolean;
}

export type TaskLane =
  | "Backlog"
  | "Blocked"
  | "Ready"
  | "Up next"
  | "Doing"
  | "Done";

export interface Task {
  id: string;
  title: string;
  ownerId: AgentId;
  lane: TaskLane;
  progress?: number;
  suggested?: boolean;
  blockReason?: string;
  origin: "user" | "agent-suggested" | "standup";
  createdAt: number;
  demo?: boolean;
}

export interface MemoryItem {
  id: string;
  agentId: AgentId;
  kind: "source" | "fact";
  label: string;
  sourceRef?: string;
  confidence?: number;
  editable: boolean;
  demo?: boolean;
}

export interface RoutingDecision {
  id: string;
  messageId: string;
  signal: "mention" | "reply" | "topic" | "floor";
  scores: Partial<Record<AgentId, number>>;
  winnerId: AgentId | null;
  runnerUpId: AgentId | null;
  interjected: boolean;
  reason: string;
  ts: number;
  demo?: boolean;
}

export interface ToolUseEvent {
  id: string;
  ts: number;
  agentId: AgentId;
  tool: string;
  summary: string;
  ok: boolean;
  detail?: string;
}

export type SuggestedTaskDraft = Omit<Task, "id" | "createdAt" | "origin" | "suggested"> & {
  id?: string;
};

/* ---------- seed data ---------- */

export const HUDDLES: Huddle[] = [
  {
    id: "daily",
    name: "Daily huddle",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Cross-agent standup and follow-ups",
    demo: true,
  },
  {
    id: "all-members",
    name: "All members",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Address the whole EDS at once — everyone is in this channel",
  },
  {
    id: "launch-war-room",
    name: "Launch week war-room",
    kind: "group",
    members: ["sam-trent", "tess-sutton", "terry-locke", "cole-blake", "eli-vaughn", "iris-chase"],
    topic: "Launch coordination",
    demo: true,
  },
  // Dedicated per-ceremony channels. Ceremonies (stand-up, retro, planning, review) run HERE, never in
  // whatever huddle happens to be open — so a stand-up started from an agent's 1:1 no longer spills its
  // whole round-robin into that private thread. Each ceremony's history is isolated and reviewable.
  {
    id: "ceremony-standup",
    name: "Stand-up",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Daily stand-up — Terry opens, each lane owner reports, blockers surface to you",
  },
  {
    id: "ceremony-retro",
    name: "Retro",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Sprint retrospective — what went well, what to improve",
  },
  {
    id: "ceremony-planning",
    name: "Planning",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Sprint planning — what each lane takes on next",
  },
  {
    id: "ceremony-review",
    name: "Review",
    kind: "group",
    members: AGENTS.map((a) => a.id),
    topic: "Sprint review — what each lane delivered",
  },
  // 1:1 huddles for the sidebar (Agent channels)
  ...AGENTS.map<Huddle>((a) => ({
    id: `dm-${a.id}`,
    name: `#${a.handle}`,
    kind: "one-to-one" as const,
    members: [a.id],
  })),
];

const now = Date.now();

export const SEED_MESSAGES: HuddleMessage[] = [
  {
    id: "m1",
    huddleId: "daily",
    author: { kind: "agent", agentId: "terry-locke" },
    text:
      "Morning briefing.\n· Finn — 3 bills clear tomorrow; you're $412 over on dining.\n· Faith — dentist vs. board call collide Thu; needs a decision.\n· Elle — EMBA essay #2 draft ready for review, due Fri.",
    ts: now - 1000 * 60 * 60,
    isBriefing: true,
  },
  {
    id: "m2",
    huddleId: "daily",
    author: { kind: "agent", agentId: "finn-reid" },
    text:
      "Want me to move the surplus from your buffer, or flag categories to trim? I've queued a suggestion either way.",
    ts: now - 1000 * 60 * 58,
  },
  {
    id: "m3",
    huddleId: "daily",
    author: { kind: "system" },
    text: "Midday check-in is ready",
    ts: now - 1000 * 60 * 50,
    checkIn: {
      kind: "midday",
      scheduledAt: "12:30",
      host: "terry-locke",
      joins: ["finn-reid", "elle-rowan", "faith-hartley"],
    },
  },
  {
    id: "m4",
    huddleId: "daily",
    author: { kind: "user" },
    text: "Flag the categories. Elle — send me the draft.",
    ts: now - 1000 * 60 * 48,
    mentions: ["elle-rowan"],
  },
  {
    id: "m5",
    huddleId: "daily",
    author: { kind: "agent", agentId: "tess-sutton" },
    text: 'Added "Trim dining budget" to the board under Ready.',
    ts: now - 1000 * 60 * 47,
  },
];

export const SEED_TASKS: Task[] = [
  {
    id: "t1",
    title: "EMBA essay #2 — first draft",
    ownerId: "elle-rowan",
    lane: "Doing",
    progress: 62,
    origin: "user",
    createdAt: now - 1000 * 60 * 60 * 20,
  },
  {
    id: "t2",
    title: "Reconcile weekly card spend",
    ownerId: "finn-reid",
    lane: "Doing",
    progress: 28,
    origin: "agent-suggested",
    createdAt: now - 1000 * 60 * 60 * 6,
  },
  {
    id: "t3",
    title: "Resolve Thu dentist / board clash",
    ownerId: "faith-hartley",
    lane: "Backlog",
    suggested: true,
    origin: "agent-suggested",
    createdAt: now - 1000 * 60 * 30,
  },
  {
    id: "t4",
    title: "Trim dining budget by $400",
    ownerId: "finn-reid",
    lane: "Up next",
    origin: "user",
    createdAt: now - 1000 * 60 * 25,
  },
  {
    id: "t5",
    title: "Pharmacy + dry-cleaning run",
    ownerId: "ezra-miles",
    lane: "Up next",
    origin: "user",
    createdAt: now - 1000 * 60 * 60 * 3,
  },
  {
    id: "t6",
    title: "Pitch narrative v2 for seed round",
    ownerId: "sam-trent",
    lane: "Ready",
    origin: "user",
    createdAt: now - 1000 * 60 * 60 * 26,
  },
  {
    id: "t7",
    title: "Waiting on Plaid re-auth",
    ownerId: "finn-reid",
    lane: "Blocked",
    blockReason: "user re-auth needed",
    origin: "agent-suggested",
    createdAt: now - 1000 * 60 * 60 * 8,
  },
  {
    id: "t8",
    title: "Meal plan — week of the 14th",
    ownerId: "charleston-lewis",
    lane: "Done",
    progress: 100,
    origin: "user",
    createdAt: now - 1000 * 60 * 60 * 26,
  },
];

export const SEED_MEMORY: MemoryItem[] = (
  [
    { id: "mem1", agentId: "finn-reid", kind: "source", label: "Plaid · card + checking", sourceRef: "plaid", editable: true },
    { id: "mem2", agentId: "finn-reid", kind: "fact", label: "Dining cap: $600/month", editable: true },
    { id: "mem3", agentId: "faith-hartley", kind: "source", label: "Google Calendar · family", sourceRef: "gcal", editable: true },
    { id: "mem4", agentId: "elle-rowan", kind: "fact", label: "Program: EMBA · cohort of 2026", editable: true },
    { id: "mem5", agentId: "flex-grimes", kind: "fact", label: "Split: push/pull/legs · 4 days", editable: true },
    { id: "mem6", agentId: "sam-trent", kind: "source", label: "Notion · pitch narrative v1", sourceRef: "notion", editable: true },
  ] as MemoryItem[]
).map((m) => ({ ...m, demo: true }));

// Mark every seeded record as demo so it can be filtered by the global toggle
// without deleting data. User-added records omit the flag.
for (const m of SEED_MESSAGES) m.demo = true;
for (const t of SEED_TASKS) t.demo = true;
