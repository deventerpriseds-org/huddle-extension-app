// Client-side store for fallback events, prompt debug, and the agent settings drawer.
import { create } from "zustand";
import type { AgentId } from "../data/agents";
import type { FallbackEvent, PromptDebug } from "./fallbacks";

interface PromptTurn {
  turnId: string;
  ts: number;
  huddleId: string;
  userText: string;
  prompts: PromptDebug[];
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
}));
