// Server-only helper. Loads the assistant snapshots JSON produced by
// `bun run scripts/fetch-openai-assistants.ts` and exposes a merged config
// for each agent (snapshot ∪ user overrides).

import snapshots from "../data/openai-assistant-snapshots.json";
import type { AgentId } from "../data/agents";

export interface AssistantSnapshot {
  assistantId: string;
  name: string | null;
  model: string;
  instructions: string | null;
  tools: Array<Record<string, unknown>>;
  toolResources: unknown;
  metadata: Record<string, string> | null;
  temperature: number | null;
  topP: number | null;
  responseFormat: unknown;
  fetchedAt: string;
}

const snap = snapshots as Record<string, AssistantSnapshot>;

export function getAssistantSnapshot(agentId: AgentId): AssistantSnapshot | null {
  return snap[agentId] ?? null;
}

/**
 * Filter snapshot tools down to shapes the Responses API accepts inline in a
 * modern call. We keep `file_search` (built-in retrieval) and `function`
 * (custom function calling), and drop `code_interpreter` — Responses supports
 * it but wiring the container/session lifecycle is beyond this app's scope.
 */
export function snapshotResponsesTools(snap: AssistantSnapshot | null): unknown[] {
  if (!snap) return [];
  return snap.tools.filter((t) => {
    const type = t?.type;
    return type === "file_search" || type === "function";
  });
}
