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
  /**
   * "critical" = the AI provider is unusable (out of quota / hard 429), so results are
   * degraded or missing and the user MUST be told loudly (persistent banner, not a toast).
   * Silent degradation is the failure mode the user explicitly rejected. Default "warn".
   */
  severity?: "warn" | "critical";
}

/**
 * True when an error message indicates the OpenAI account is OUT OF QUOTA / hard-throttled
 * (not a transient blip). These must surface to the user, never silently keyword-fallback.
 */
export function isQuotaError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("insufficient_quota") ||
    m.includes("exceeded your current quota") ||
    m.includes("billing") ||
    (m.includes("429") && m.includes("quota")) ||
    m.includes("rate limit") && m.includes("quota")
  );
}

/** User-facing banner text for a quota outage — explicit so the user realises what's wrong. */
export const QUOTA_OUTAGE_INLINE =
  "OpenAI is out of API quota — agent routing and replies are degraded and may be wrong until the account is topped up.";

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
