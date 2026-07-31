import { useMemo } from "react";
import { create } from "zustand";

import { AGENT_BY_ID, AGENTS, type AgentId } from "./data/agents";
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

type View = "huddle" | "board" | "artifacts";
export type ContextPanelTab = "queue" | "activity" | "memory";

// Pure client-device UI layout prefs (panel collapse, active side-panel tab) — deliberately NOT part
// of PERSISTED_KEYS/getPersistablePayload: these are not workspace data, don't sync across devices,
// and must survive sign-out (they describe how THIS device likes its chrome, not user content).
const SIDEBAR_COLLAPSED_KEY = "huddle:sidebarCollapsed";
const CONTEXT_PANEL_COLLAPSED_KEY = "huddle:contextPanelCollapsed";

// Exported so other device-local UI prefs (e.g. BoardView's quick-filters row expand/collapse) reuse
// the same read/write instead of re-implementing localStorage boolean plumbing.
export function readBoolPref(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeBoolPref(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export type MeetingKind = "morning" | "midday" | "afternoon" | "adhoc" | "virtual-meeting";
export type CeremonyKind = "standup" | "retro" | "planning" | "review" | "review_retro";
export interface CeremonyTurn {
  agentId?: AgentId; // omitted for a user turn
  text: string;
  user?: boolean;
  ts?: number; // epoch ms, stamped on append — drives the transcript's MM:SS timestamps
  // Set true on the speaker row that was cut mid-sentence by a barge — renders an [interrupted] marker.
  interrupted?: boolean;
  // "barge" = the user's interjection; "answer" = the immediate reply spoken over the frozen ceremony.
  kind?: "barge" | "answer";
}
export interface MeetingState {
  kind: MeetingKind;
  startedAt: number;
  expanded: boolean;
  activeSpeakerId: AgentId;
  // The live participant list — you can invite/remove agents during the meeting. Messages in the
  // meeting fan out to exactly these members, so a freshly-invited agent answers the next turn.
  members: AgentId[];
  // Ceremony ("virtual-meeting") extras — the transcript shows in the right pane, Zoom/Teams-style.
  ceremonyType?: CeremonyKind;
  ceremonyStatus?: "ready" | "running" | "done" | "error";
  transcript?: CeremonyTurn[];
}

interface HuddleState {
  activeHuddleId: string;
  view: View;
  // Artifact to focus when the Artifacts view opens (set by clicking an "Open <name>" chip in chat).
  // ArtifactsView reads it, opens that artifact, then clears it. Not persisted (transient UI intent).
  activeArtifactId: string | null;
  huddles: Huddle[];
  messages: HuddleMessage[];
  tasks: Task[];
  memory: MemoryItem[];
  decisions: RoutingDecision[];
  toolUses: ToolUseEvent[];
  journeyTasks: JourneyTask[];
  showDemoData: boolean;
  meeting: null | MeetingState;
  // Desktop panel chrome (device-local, read synchronously from localStorage so there's no
  // collapsed-then-flash-expanded flicker on first paint — see readBoolPref above).
  sidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
  contextPanelTab: ContextPanelTab;
  toggleSidebarCollapsed: () => void;
  toggleContextPanelCollapsed: () => void;
  setContextPanelTab: (tab: ContextPanelTab) => void;
  setActive: (id: string) => void;
  setView: (v: View) => void;
  // Open the Artifacts view focused on a specific artifact (from a chat chip); null just clears focus.
  openArtifactById: (id: string | null) => void;
  addUserMessage: (m: HuddleMessage) => void;
  addAgentMessage: (m: HuddleMessage) => void;
  logDecision: (d: RoutingDecision) => void;
  addToolUses: (events: ToolUseEvent[]) => void;
  moveTask: (id: string, lane: TaskLane) => void;
  addSuggestedTasks: (tasks: SuggestedTaskDraft[]) => void;
  approveTask: (id: string) => void;
  skipTask: (id: string) => void;
  startMeeting: (
    kind: MeetingKind,
    opts?: { ceremonyType?: CeremonyKind; speakerId?: AgentId; expanded?: boolean; members?: AgentId[] },
  ) => void;
  toggleMeetingExpanded: () => void;
  leaveMeeting: () => void;
  setSpeaker: (id: AgentId) => void;
  patchMeeting: (patch: Partial<MeetingState>) => void;
  inviteAgent: (id: AgentId) => void;
  removeAgent: (id: AgentId) => void;
  toggleAgent: (id: AgentId) => void;
  addMeetingTurns: (turns: CeremonyTurn[]) => void;
  // Mark the most recent AGENT transcript row as interrupted (cut mid-sentence by a barge). No-op
  // when the last row is a user turn or the transcript is empty (barge while nobody was speaking).
  markLastAgentTurnInterrupted: () => void;
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
  activeArtifactId: null,
  huddles: HUDDLES,
  messages: SEED_MESSAGES,
  tasks: SEED_TASKS,
  memory: SEED_MEMORY,
  decisions: [],
  toolUses: [],
  journeyTasks: [],
  showDemoData: true,
  meeting: null,
  sidebarCollapsed: readBoolPref(SIDEBAR_COLLAPSED_KEY),
  contextPanelCollapsed: readBoolPref(CONTEXT_PANEL_COLLAPSED_KEY),
  contextPanelTab: "queue",
  toggleSidebarCollapsed: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      writeBoolPref(SIDEBAR_COLLAPSED_KEY, next);
      return { sidebarCollapsed: next };
    }),
  toggleContextPanelCollapsed: () =>
    set((s) => {
      const next = !s.contextPanelCollapsed;
      writeBoolPref(CONTEXT_PANEL_COLLAPSED_KEY, next);
      return { contextPanelCollapsed: next };
    }),
  setContextPanelTab: (tab) => set({ contextPanelTab: tab }),
  setActive: (id) => set({ activeHuddleId: id, view: "huddle" }),
  setView: (v) => set({ view: v }),
  openArtifactById: (id) =>
    set(id ? { activeArtifactId: id, view: "artifacts" } : { activeArtifactId: null }),
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
      // Backstop dedup: drop any suggestion whose title already exists on the board (a duplicate that
      // slipped past the server-side per-turn dedup, or the same title arriving twice). Title-keyed
      // because each duplicate carries a distinct random id, so id-dedup alone can't collapse them.
      const seenTitles = new Set(s.tasks.map((t) => t.title.trim().toLowerCase()));
      const fresh = incoming.filter((t) => {
        const key = (t.title ?? "").trim().toLowerCase();
        if (!key || seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
      if (fresh.length === 0) return {};
      const tasks = fresh.map((t, i): Task => ({
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
  startMeeting: (kind, opts) =>
    set({
      meeting: {
        kind,
        startedAt: Date.now(),
        // Virtual meetings open expanded (the transcript stage); a composer voice call can also
        // request expanded. Speaker defaults to the scrum master unless the caller names one.
        expanded: opts?.expanded ?? kind === "virtual-meeting",
        activeSpeakerId: opts?.speakerId ?? "terry-locke",
        // Ceremonies seat the FULL roster (toggle any off in the meeting); other meetings start with
        // whatever the caller passes (a 1:1 seeds that one agent; a blank meeting seeds none).
        members: opts?.members ?? (kind === "virtual-meeting" ? AGENTS.map((a) => a.id) : []),
        // A ceremony (ceremonyType passed) opens in "ready" state with a Run button; a blank/invite
        // virtual meeting has no ceremonyType, so it renders the interactive composer instead.
        ...(opts?.ceremonyType
          ? { ceremonyType: opts.ceremonyType, ceremonyStatus: "ready" as const, transcript: [] }
          : kind === "virtual-meeting"
            ? { transcript: [] }
            : {}),
      },
    }),
  toggleMeetingExpanded: () =>
    set((s) => (s.meeting ? { meeting: { ...s.meeting, expanded: !s.meeting.expanded } } : {})),
  leaveMeeting: () => set({ meeting: null }),
  setSpeaker: (id) =>
    set((s) => (s.meeting ? { meeting: { ...s.meeting, activeSpeakerId: id } } : {})),
  patchMeeting: (patch) =>
    set((s) => (s.meeting ? { meeting: { ...s.meeting, ...patch } } : {})),
  inviteAgent: (id) =>
    set((s) =>
      s.meeting && !s.meeting.members.includes(id)
        ? { meeting: { ...s.meeting, members: [...s.meeting.members, id] } }
        : {},
    ),
  removeAgent: (id) =>
    set((s) =>
      s.meeting ? { meeting: { ...s.meeting, members: s.meeting.members.filter((m) => m !== id) } } : {},
    ),
  toggleAgent: (id) =>
    set((s) => {
      if (!s.meeting) return {};
      const has = s.meeting.members.includes(id);
      return {
        meeting: {
          ...s.meeting,
          members: has ? s.meeting.members.filter((m) => m !== id) : [...s.meeting.members, id],
        },
      };
    }),
  addMeetingTurns: (turns) =>
    set((s) => {
      if (!s.meeting) return {};
      const now = Date.now();
      const stamped = turns.map((t) => ({ ...t, ts: t.ts ?? now }));
      return { meeting: { ...s.meeting, transcript: [...(s.meeting.transcript ?? []), ...stamped] } };
    }),
  markLastAgentTurnInterrupted: () =>
    set((s) => {
      if (!s.meeting) return {};
      const t = s.meeting.transcript ?? [];
      // Find the last AGENT row (skip trailing user rows, e.g. the just-added barge message).
      let idx = -1;
      for (let i = t.length - 1; i >= 0; i--) {
        if (!t[i].user) { idx = i; break; }
      }
      if (idx === -1) return {};
      const next = t.slice();
      next[idx] = { ...next[idx], interrupted: true };
      return { meeting: { ...s.meeting, transcript: next } };
    }),
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
      // Collapse same-title duplicates (distinct journey uuids minted for one intent when more than
      // one agent created it) so the board shows a single card. Keep the first per normalized title;
      // tasks with no title are left untouched.
      const out: JourneyTask[] = [];
      const seenTitles = new Set<string>();
      for (const t of byId.values()) {
        const key = (t.title ?? "").trim().toLowerCase();
        if (key) {
          if (seenTitles.has(key)) continue;
          seenTitles.add(key);
        }
        out.push(t);
      }
      return { journeyTasks: out };
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
    workspaceHydrated = true;
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
  // A push deep link (`?huddle=<id>`) is an explicit intent to open that channel; it must WIN over the
  // workspace-synced activeHuddleId restored here. Without this, hydration (which resolves async, after
  // the deep-link effect already switched channels) reverts you to your last-synced channel — the
  // "flash Sam's chat then bounce back to Iris" bug. Consumed once so later manual navigation is free.
  const restoredActive = p.activeHuddleId ?? seed.activeHuddleId;
  const dl = deepLinkTarget;
  const activeHuddleId =
    dl && useHuddleStore.getState().huddles.some((h) => h.id === dl) ? dl : restoredActive;
  if (dl) deepLinkTarget = null;
  useHuddleStore.setState({
    activeHuddleId,
    messages,
    tasks: Array.isArray(p.tasks) ? p.tasks : seed.tasks,
    memory: Array.isArray(p.memory) ? p.memory : seed.memory,
    decisions: Array.isArray(p.decisions) ? p.decisions : seed.decisions,
    journeyTasks: Array.isArray(p.journeyTasks) ? p.journeyTasks : seed.journeyTasks,
    showDemoData: typeof p.showDemoData === "boolean" ? p.showDemoData : seed.showDemoData,
  });
  workspaceHydrated = true;
}

// True once the store has been hydrated from remote (or seeded). The app-global durable-turn back-fill
// gates on this: it must add messages ON TOP of the hydrated array, never before hydrate replaces it —
// a pre-hydrate add would be discarded by hydration while its cursor advanced, permanently losing the
// message. Set by hydrateFromRemote / resetWorkspace; read via isWorkspaceHydrated().
let workspaceHydrated = false;
export function isWorkspaceHydrated(): boolean {
  return workspaceHydrated;
}

// Deep-link target captured from `?huddle=<id>` before the URL param is cleaned. hydrateFromRemote
// honors it so a push tap wins over the synced last-active channel. Null when no pending deep link.
let deepLinkTarget: string | null = null;
export function setDeepLinkTarget(id: string | null): void {
  deepLinkTarget = id;
}

/** Reset store to seed defaults (used on sign-out). */
export function resetWorkspace() {
  useHuddleStore.setState(seedDefaults());
  // Not hydrated to real content — a fresh session must re-hydrate before the back-fill may add, so it
  // never writes onto a seed store that hydration is about to replace.
  workspaceHydrated = false;
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
