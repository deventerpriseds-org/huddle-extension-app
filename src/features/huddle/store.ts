import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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
  type Task,
  type TaskLane,
} from "./data/seed";

type View = "huddle" | "board";

interface HuddleState {
  activeHuddleId: string;
  view: View;
  huddles: Huddle[];
  messages: HuddleMessage[];
  tasks: Task[];
  memory: MemoryItem[];
  decisions: RoutingDecision[];
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
  moveTask: (id: string, lane: TaskLane) => void;
  approveTask: (id: string) => void;
  skipTask: (id: string) => void;
  startMeeting: (kind: "morning" | "midday" | "afternoon" | "adhoc") => void;
  toggleMeetingExpanded: () => void;
  leaveMeeting: () => void;
  setSpeaker: (id: AgentId) => void;
  clearDemoData: () => void;
}

export const useHuddleStore = create<HuddleState>()(
  persist(
    (set) => ({
      activeHuddleId: "daily",
      view: "huddle",
      huddles: HUDDLES,
      messages: SEED_MESSAGES,
      tasks: SEED_TASKS,
      memory: SEED_MEMORY,
      decisions: [],
      meeting: null,
      setActive: (id) => set({ activeHuddleId: id, view: "huddle" }),
      setView: (v) => set({ view: v }),
      addUserMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
      addAgentMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
      logDecision: (d) => set((s) => ({ decisions: [d, ...s.decisions].slice(0, 50) })),
      moveTask: (id, lane) =>
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? { ...t, lane, progress: lane === "Done" ? 100 : t.progress }
              : t,
          ),
        })),
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
    }),
    {
      name: "huddle-workspace",
      version: 2,
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
      skipHydration: typeof window === "undefined",
      partialize: (s) => ({
        messages: s.messages,
        tasks: s.tasks,
        decisions: s.decisions,
        activeHuddleId: s.activeHuddleId,
      }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<HuddleState>;
        const validMessages = (p.messages ?? []).filter((m) => {
          if (!m || !m.author) return false;
          if (m.author.kind === "agent") {
            return !!AGENT_BY_ID[m.author.agentId as AgentId];
          }
          return true;
        });
        return { ...p, messages: validMessages } as Partial<HuddleState>;
      },
    },

  ),
);
