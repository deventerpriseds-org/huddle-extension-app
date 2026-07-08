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
 * Reshape Assistants-API tool definitions into the flat shape the Responses
 * API accepts. Assistants nests function/file_search config one level deep;
 * Responses expects a flat object with `name`/`vector_store_ids` at the top.
 * Drops `code_interpreter` and anything unrecognized.
 */
export function snapshotResponsesTools(
  snap: AssistantSnapshot | null,
): unknown[] {
  if (!snap) return [];
  const vectorStoreIds =
    (snap.toolResources as { file_search?: { vector_store_ids?: string[] } } | null)
      ?.file_search?.vector_store_ids ?? [];

  const out: unknown[] = [];
  for (const t of snap.tools) {
    const type = (t as { type?: string }).type;
    if (type === "file_search") {
      if (vectorStoreIds.length === 0) continue; // Responses requires ids
      out.push({ type: "file_search", vector_store_ids: vectorStoreIds });
    } else if (type === "function") {
      // Assistants: { type:"function", function:{ name, description, parameters } }
      // Responses:  { type:"function", name, description, parameters }
      const fn = (t as { function?: Record<string, unknown> }).function;
      const flat = t as Record<string, unknown>;
      const name = (fn?.name ?? flat.name) as string | undefined;
      if (!name) continue;
      out.push({
        type: "function",
        name,
        description: (fn?.description ?? flat.description) as string | undefined,
        parameters: (fn?.parameters ?? flat.parameters) as
          | Record<string, unknown>
          | undefined,
      });
    }
  }
  return out;
}
