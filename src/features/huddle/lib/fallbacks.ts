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

/**
 * WHY a model call failed, as a KIND only: an HTTP status, a known OpenAI error code, "timeout", or the error's
 * class -- never the message text, which can echo the input (this repo's logs are public). Moved here from
 * scripts/proposals-preview.ts (2026-11-17) so every background AI job logs failures the same way.
 */
export function aiFailureKind(e: unknown): string {
  const m = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = m.match(/\b(insufficient_quota|rate_limit_exceeded|invalid_api_key|model_not_found|context_length_exceeded|invalid_request_error|server_error)\b/)?.[1];
  const status = m.match(/\b([45]\d\d)\b/)?.[1];
  if (/timeout/i.test(m)) return "timeout";
  if (status || code) return [status, code].filter(Boolean).join(" ");
  return (e as { name?: string })?.name || "Error";
}

/** The background-job quota alert (bell item + Iris's 1:1 notice), 2026-11-17. Names the job that hit it. */
export const AI_QUOTA_PAUSED_TEXT =
  "OpenAI is out of credit. AI checks, agent replies and routing are paused until the account is topped up.";
export const AI_QUOTA_RECOVERED_TEXT = "OpenAI calls are working again.";

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
  /** Router-scored difficulty (1-4) for this turn, if the difficulty resolver ran. Central tracking. */
  difficulty?: number | null;
  /** Reasoning effort the resolver chose (low/medium/high), if any. Central tracking. */
  effort?: string | null;
}
