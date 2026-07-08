// Shared types + labels for fallback events. Client-safe (no server-only imports).
import type { AgentId } from "../data/agents";

export type FallbackSubsystem =
  | "openai"
  | "snapshot"
  | "router"
  | "rag"
  | "tool"
  | "lovable"
  | "config";

export interface FallbackEvent {
  id: string;
  ts: number;
  agentId?: AgentId;
  subsystem: FallbackSubsystem;
  reason: string;
  /** Short one-line label appended to the agent's reply. */
  inline: string;
}

export const SUBSYSTEM_LABEL: Record<FallbackSubsystem, string> = {
  openai: "OpenAI Responses",
  snapshot: "Assistant snapshot",
  router: "LLM router",
  rag: "RAG store",
  tool: "Agent tool",
  lovable: "Lovable AI",
  config: "Configuration",
};

/** Compact prompt bundle we return to the client so users can inspect what was sent. */
export interface PromptDebug {
  agentId: AgentId;
  backend: "openai" | "lovable";
  model: string;
  instructions: string;
  /** Snapshot instructions used verbatim, if any. */
  fromSnapshot: boolean;
  /** Optional resolved tool list. */
  toolTypes: string[];
}
