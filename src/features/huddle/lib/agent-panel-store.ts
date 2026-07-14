// Client-side store for fallback events, prompt debug, and the agent settings drawer.
import { create } from "zustand";
import type { AgentId } from "../data/agents";
import type { FallbackEvent, PromptDebug } from "./fallbacks";

export interface TurnToolUse {
  agentId?: AgentId;
  tool: string;
  status: string;
  ok: boolean;
  detail?: string;
}

interface PromptTurn {
  turnId: string;
  ts: number;
  huddleId: string;
  userText: string;
  prompts: PromptDebug[];
  /** What the agent(s) actually did this turn — tools called, results. */
  toolUses?: TurnToolUse[];
  /** OpenAI reasoning summary text, when the model exposes one. */
  reasoning?: string[];
}

/** A turn in flight — drives the typing indicator + "thinking" panel. */
export interface PendingTurn {
  huddleId: string;
  agentId?: AgentId;
  startedAt: number;
  /** Durable turn id — lets the delivery loop reclaim this turn's result after a reload/background. */
  turnId?: string;
}

// Persist the in-flight turn so a full reload (or the OS evicting a backgrounded PWA) still shows the
// "thinking" indicator and the delivery loop can pick the finished reply back up. Stale entries
// (>10 min) are dropped so a crashed turn doesn't spin forever.
const PENDING_KEY = "huddle-pending";
function loadPending(): PendingTurn | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingTurn;
    if (!p || typeof p.startedAt !== "number" || Date.now() - p.startedAt > 10 * 60_000) {
      window.localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}
function savePending(p: PendingTurn | null) {
  if (typeof window === "undefined") return;
  try {
    if (p) window.localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore quota/serialization errors */
  }
}

interface AgentPanelState {
  // Drawer state
  openAgentId: AgentId | null;
  openAgent: (id: AgentId) => void;
  closeAgent: () => void;

  // Fallback log
  fallbacks: FallbackEvent[];
  addFallbacks: (events: FallbackEvent[]) => void;
  clearFallbacks: () => void;

  // Prompt history (last 50 turns)
  turns: PromptTurn[];
  recordTurn: (turn: PromptTurn) => void;

  // In-flight turn (typing indicator / live activity)
  pending: PendingTurn | null;
  setPending: (p: PendingTurn) => void;
  clearPending: () => void;
}

export const useAgentPanelStore = create<AgentPanelState>((set) => ({
  openAgentId: null,
  openAgent: (id) => set({ openAgentId: id }),
  closeAgent: () => set({ openAgentId: null }),

  fallbacks: [],
  addFallbacks: (events) =>
    set((s) => ({ fallbacks: [...events, ...s.fallbacks].slice(0, 200) })),
  clearFallbacks: () => set({ fallbacks: [] }),

  turns: [],
  recordTurn: (turn) => set((s) => ({ turns: [turn, ...s.turns].slice(0, 50) })),

  pending: loadPending(),
  setPending: (p) => {
    savePending(p);
    set({ pending: p });
  },
  clearPending: () => {
    savePending(null);
    set({ pending: null });
  },
}));
