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

  pending: null,
  setPending: (p) => set({ pending: p }),
  clearPending: () => set({ pending: null }),
}));
