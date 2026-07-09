import { useMemo } from "react";
import { create } from "zustand";

import { AGENT_BY_ID, type AgentId } from "./data/agents";
import {
  HUDDLES,
  SEED_MEMORY,
  SEED_MESSAGES,
  SEED_TASKS,
  type Huddle,
  type HuddleMessage,
  type MemoryItem,
  type RoutingDecision,
  type SuggestedTaskDraft,
  type Task,
  type TaskLane,
  type ToolUseEvent,
} from "./data/seed";
import type { JourneyTask } from "./lib/journey/types";

type View = "huddle" | "board";

interface HuddleState {
  activeHuddleId: string;
  view: View;
  huddles: Huddle[];
  messages: HuddleMessage[];
  tasks: Task[];
  memory: MemoryItem[];
  decisions: RoutingDecision[];
  toolUses: ToolUseEvent[];
  journeyTasks: JourneyTask[];
  showDemoData: boolean;
  meeting: null | {
    kind: "morning" | "midday" | "afternoon" | "adhoc";
    startedAt: number;
    expanded: boolean;
    activeSpeakerId: AgentId;
  };
  setActive: (id: string) => void;
  setView: (v: View) => void;
  addUserMessage: (m: HuddleMessage) => void;
  addAgentMessage: (m: HuddleMessage) => void;
  logDecision: (d: RoutingDecision) => void;
  addToolUses: (events: ToolUseEvent[]) => void;
  moveTask: (id: string, lane: TaskLane) => void;
  addSuggestedTasks: (tasks: SuggestedTaskDraft[]) => void;
  approveTask: (id: string) => void;
  skipTask: (id: string) => void;
  startMeeting: (kind: "morning" | "midday" | "afternoon" | "adhoc") => void;
  toggleMeetingExpanded: () => void;
  leaveMeeting: () => void;
  setSpeaker: (id: AgentId) => void;
  setShowDemoData: (v: boolean) => void;
  addMemoryItem: (item: Omit<MemoryItem, "id"> & { id?: string }) => void;
  removeMemoryItem: (id: string) => void;
  upsertJourneyTasks: (tasks: JourneyTask[]) => void;
}

const PERSISTED_KEYS = [
  "messages",
  "tasks",
  "memory",
  "decisions",
  "activeHuddleId",
  "showDemoData",
  "journeyTasks",
] as const;

type PersistedKey = (typeof PERSISTED_KEYS)[number];
export type PersistedWorkspace = Pick<HuddleState, PersistedKey>;

function seedDefaults(): PersistedWorkspace {
  return {
    activeHuddleId: "daily",
    messages: SEED_MESSAGES,
    tasks: SEED_TASKS,
    memory: SEED_MEMORY,
    decisions: [],
    journeyTasks: [],
    showDemoData: true,
  };
}

export const useHuddleStore = create<HuddleState>()((set) => ({
  activeHuddleId: "daily",
  view: "huddle",
  huddles: HUDDLES,
  messages: SEED_MESSAGES,
  tasks: SEED_TASKS,
  memory: SEED_MEMORY,
  decisions: [],
  toolUses: [],
  journeyTasks: [],
  showDemoData: true,
  meeting: null,
  setActive: (id) => set({ activeHuddleId: id, view: "huddle" }),
  setView: (v) => set({ view: v }),
  addUserMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  addAgentMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  logDecision: (d) => set((s) => ({ decisions: [d, ...s.decisions].slice(0, 50) })),
  addToolUses: (events) =>
    set((s) => ({ toolUses: [...events, ...s.toolUses].slice(0, 100) })),
  moveTask: (id, lane) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, lane, progress: lane === "Done" ? 100 : t.progress }
          : t,
      ),
    })),
  addSuggestedTasks: (incoming) =>
    set((s) => {
      if (!incoming || incoming.length === 0) return {};
      const now = Date.now();
      const tasks = incoming.map((t, i): Task => ({
        id: t.id ?? `task-${now.toString(36)}-${i}`,
        title: t.title,
        ownerId: t.ownerId,
        lane: t.lane,
        progress: t.progress,
        blockReason: t.blockReason,
        suggested: true,
        origin: "agent-suggested",
        createdAt: now + i,
      }));
      return { tasks: [...tasks, ...s.tasks] };
    }),
  approveTask: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, suggested: false, lane: "Doing", progress: t.progress ?? 5 } : t,
      ),
    })),
  skipTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  startMeeting: (kind) =>
    set({
      meeting: {
        kind,
        startedAt: Date.now(),
        expanded: false,
        activeSpeakerId: "terry-locke",
      },
    }),
  toggleMeetingExpanded: () =>
    set((s) => (s.meeting ? { meeting: { ...s.meeting, expanded: !s.meeting.expanded } } : {})),
  leaveMeeting: () => set({ meeting: null }),
  setSpeaker: (id) =>
    set((s) => (s.meeting ? { meeting: { ...s.meeting, activeSpeakerId: id } } : {})),
  setShowDemoData: (v) => set({ showDemoData: v }),
  addMemoryItem: (item) =>
    set((s) => ({
      memory: [
        ...s.memory,
        {
          id: item.id ?? `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          agentId: item.agentId,
          kind: item.kind,
          label: item.label,
          sourceRef: item.sourceRef,
          confidence: item.confidence,
          editable: item.editable ?? true,
        },
      ],
    })),
  removeMemoryItem: (id) =>
    set((s) => ({ memory: s.memory.filter((m) => m.id !== id) })),
  upsertJourneyTasks: (incoming) =>
    set((s) => {
      if (!incoming || incoming.length === 0) return {};
      const byId = new Map<string, JourneyTask>();
      for (const t of s.journeyTasks) byId.set(t.id, t);
      for (const t of incoming) byId.set(t.id, { ...t, origin: "journey-voice" });
      return { journeyTasks: Array.from(byId.values()) };
    }),
}));

/** Snapshot of persistable fields for remote sync. */
export function getPersistablePayload(): PersistedWorkspace {
  const s = useHuddleStore.getState();
  return {
    messages: s.messages,
    tasks: s.tasks,
    memory: s.memory,
    decisions: s.decisions,
    activeHuddleId: s.activeHuddleId,
    showDemoData: s.showDemoData,
    journeyTasks: s.journeyTasks,
  };
}

/** Merge a remote workspace blob into the store, filtering invalid messages. */
export function hydrateFromRemote(blob: Record<string, unknown> | null | undefined) {
  const seed = seedDefaults();
  if (!blob || typeof blob !== "object") {
    useHuddleStore.setState(seed);
    return;
  }
  const p = blob as Partial<PersistedWorkspace>;
  const messages = Array.isArray(p.messages)
    ? p.messages.filter((m) => {
        if (!m || !m.author) return false;
        if (m.author.kind === "agent") {
          return !!AGENT_BY_ID[m.author.agentId as AgentId];
        }
        return true;
      })
    : seed.messages;
  useHuddleStore.setState({
    activeHuddleId: p.activeHuddleId ?? seed.activeHuddleId,
    messages,
    tasks: Array.isArray(p.tasks) ? p.tasks : seed.tasks,
    memory: Array.isArray(p.memory) ? p.memory : seed.memory,
    decisions: Array.isArray(p.decisions) ? p.decisions : seed.decisions,
    journeyTasks: Array.isArray(p.journeyTasks) ? p.journeyTasks : seed.journeyTasks,
    showDemoData: typeof p.showDemoData === "boolean" ? p.showDemoData : seed.showDemoData,
  });
}

/** Reset store to seed defaults (used on sign-out). */
export function resetWorkspace() {
  useHuddleStore.setState(seedDefaults());
}

/** One-shot migration: read legacy localStorage `huddle-workspace` if present. */
export function readLegacyLocalWorkspace(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("huddle-workspace");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // zustand persist wraps state under `state` with `version` sibling.
    if (parsed && typeof parsed === "object" && parsed.state) return parsed.state as Record<string, unknown>;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function clearLegacyLocalWorkspace() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("huddle-workspace");
  } catch {
    // ignore
  }
}


/* ---------------- Demo-aware selectors ---------------- */
// Keep raw arrays in the store; expose visibility-filtered views so a global
// "Show demo data" toggle can hide seeded records without deleting them.

function useFilterDemo<T extends { demo?: boolean }>(items: T[]): T[] {
  const show = useHuddleStore((s) => s.showDemoData);
  return useMemo(() => (show ? items : items.filter((i) => !i.demo)), [items, show]);
}

export const useVisibleMessages = () => useFilterDemo(useHuddleStore((s) => s.messages));
export const useVisibleTasks = () => useFilterDemo(useHuddleStore((s) => s.tasks));
export const useVisibleMemory = () => useFilterDemo(useHuddleStore((s) => s.memory));
export const useVisibleDecisions = () => useFilterDemo(useHuddleStore((s) => s.decisions));
export const useVisibleHuddles = () => useFilterDemo(useHuddleStore((s) => s.huddles));
export const useToolUses = () => useHuddleStore((s) => s.toolUses);
