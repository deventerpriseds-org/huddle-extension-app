// OpenAI Responses "function" tool schemas + dispatcher. The model decides
// when to call search_memory (chunks) vs lookup_facts (triples).

import type { RagStore } from "./types";

export const SEARCH_MEMORY_TOOL = {
  type: "function" as const,
  name: "search_memory",
  description:
    "Semantic search over past conversations, notes, and documents. Use when the user's question is about topics, events, or open-ended context — anything where meaning matters more than exact facts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Natural-language query to embed and search." },
      k: { type: "number", description: "Number of results (1-20). Default 6." },
    },
    required: ["query"],
  },
  strict: false,
};

export const LOOKUP_FACTS_TOOL = {
  type: "function" as const,
  name: "lookup_facts",
  description:
    "Structured fact lookup: preferences, allergies, ownership, deadlines, relationships, commitments. Use for direct factual questions about a person or entity (e.g. 'what is X allergic to', 'who owns Y', 'when is Z due'). Prefer this over search_memory when the answer is a specific fact.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string", description: "Entity to look up (e.g. 'user', 'shellfish')." },
      predicate: { type: "string", description: "Relationship to filter (e.g. 'allergic_to')." },
      query: { type: "string", description: "Free-text query across all triple fields." },
      k: { type: "number", description: "Max results (1-30). Default 8." },
    },
    required: [],
  },
  strict: false,
};

export function buildRagTools(opts: {
  chunks: boolean;
  triples: boolean;
  fileSearch: boolean;
  vectorStoreId?: string;
}): unknown[] {
  const tools: unknown[] = [];
  if (opts.chunks) tools.push(SEARCH_MEMORY_TOOL);
  if (opts.triples) tools.push(LOOKUP_FACTS_TOOL);
  if (opts.fileSearch && opts.vectorStoreId) {
    tools.push({ type: "file_search", vector_store_ids: [opts.vectorStoreId] });
  }
  return tools;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export async function dispatchTool(
  store: RagStore,
  agentId: string,
  call: ToolCall,
): Promise<string> {
  if (call.name === "search_memory") {
    const q = String(call.arguments.query ?? "").trim();
    if (!q) return JSON.stringify({ results: [] });
    const k = typeof call.arguments.k === "number" ? call.arguments.k : 6;
    const rows = await store.searchChunks({ query: q, k, agentId });
    return JSON.stringify({
      results: rows.map((r) => ({
        text: r.text,
        source: r.source,
        score: r.score,
        prefix: "[CONTEXT]",
      })),
    });
  }
  if (call.name === "lookup_facts") {
    const rows = await store.lookupTriples({
      subject: call.arguments.subject as string | undefined,
      predicate: call.arguments.predicate as string | undefined,
      query: call.arguments.query as string | undefined,
      k: (call.arguments.k as number | undefined) ?? 8,
      agentId,
    });
    return JSON.stringify({
      results: rows.map((r) => ({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        confidence: r.confidence,
        prefix: "[FACT]",
      })),
    });
  }
  return JSON.stringify({ error: `Unknown tool: ${call.name}` });
}

export const RAG_SYSTEM_HINT =
  "You have memory tools. Use `lookup_facts` for direct factual questions about people or things (allergies, ownership, deadlines, preferences). Use `search_memory` for topical or open-ended recall. Call both when useful. Treat [FACT] results as ground truth and [CONTEXT] results as supporting information.";
