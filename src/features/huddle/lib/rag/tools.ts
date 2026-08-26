// OpenAI Responses "function" tool schemas + dispatcher. The model decides
// when to call search_memory (chunks) vs lookup_facts (triples).

import { AGENT_BY_ID, type AgentId } from "../../data/agents";
import type { RagStore, SharingMode } from "./types";

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

// Returned to the model (never to the user) when a memory/fact lookup comes back empty. Retrieval is a
// SILENT background aid: an empty result must be invisible, NOT narrated as "I couldn't find that."
// Structural (not just prompt) so it holds even when the model ignores the prose house-style.
const EMPTY_RESULT_GUIDANCE =
  "No additional stored memory matched this lookup — this is normal and expected, NOT a problem to report. " +
  "Answer the user directly from the conversation so far and your general knowledge. Do NOT tell the user " +
  "you searched, that memory/files/attachments were checked, or that nothing was found; never say things " +
  "like 'I couldn't find', 'no details in the files', or 'nothing matched'. Just respond naturally. If you " +
  "genuinely lack a specific fact they asked for, ask one brief clarifying question or offer to note it — " +
  "without narrating the search.";

/**
 * Map author agent ids to display names, excluding the calling agent
 * (their own memory needs no attribution). Returns null when the result
 * has no other-agent authors — the model should speak as itself.
 */
function attributionSuffix(authorIds: string[] | undefined, callerId: string): string | null {
  if (!authorIds || authorIds.length === 0) return null;
  const others = authorIds.filter((id) => id !== callerId);
  if (others.length === 0) return null;
  // De-duplicated: writeChunk merges author_agent_ids on a repeat write, and a partially-overlapping
  // author set can leave the same id twice. Without this, attribution reads "Finn, Finn".
  const names = [
    ...new Set(
      others
        .map((id) => AGENT_BY_ID[id as AgentId]?.name)
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  if (names.length === 0) return null;
  return names.join(", ");
}

export async function dispatchTool(
  store: RagStore,
  agentId: string,
  call: ToolCall,
  mode: SharingMode = "shared",
): Promise<string> {
  if (call.name === "search_memory") {
    const q = String(call.arguments.query ?? "").trim();
    if (!q) return JSON.stringify({ results: [], guidance: EMPTY_RESULT_GUIDANCE });
    const k = typeof call.arguments.k === "number" ? call.arguments.k : 6;
    const rows = await store.searchChunks({ query: q, k, agentId, mode });
    // Invisible retrieval: an empty semantic search is NORMAL, not an answer. Return neutral guidance
    // so the model answers from the live conversation instead of narrating a miss ("I couldn't find
    // that in the files/memory") — the exact behavior that made agents look brain-dead one turn later.
    if (rows.length === 0) return JSON.stringify({ results: [], guidance: EMPTY_RESULT_GUIDANCE });
    return JSON.stringify({
      results: rows.map((r) => {
        const from = attributionSuffix(r.authorAgentIds, agentId);
        return {
          prefix: from ? `[CONTEXT from ${from}]` : "[CONTEXT]",
          text: r.text,
          source: r.source,
          score: r.score,
        };
      }),
    });
  }
  if (call.name === "lookup_facts") {
    const rows = await store.lookupTriples({
      subject: call.arguments.subject as string | undefined,
      predicate: call.arguments.predicate as string | undefined,
      query: call.arguments.query as string | undefined,
      k: (call.arguments.k as number | undefined) ?? 8,
      agentId,
      mode,
    });
    if (rows.length === 0) return JSON.stringify({ results: [], guidance: EMPTY_RESULT_GUIDANCE });
    return JSON.stringify({
      results: rows.map((r) => {
        const from = attributionSuffix(r.authorAgentIds, agentId);
        return {
          prefix: from ? `[FACT from ${from}]` : "[FACT]",
          subject: r.subject,
          predicate: r.predicate,
          object: r.object,
          confidence: r.confidence,
        };
      }),
    });
  }
  return JSON.stringify({ error: `Unknown tool: ${call.name}` });
}

export const RAG_SYSTEM_HINT =
  "You have memory tools. Use `lookup_facts` for direct factual questions about people or things (allergies, ownership, deadlines, preferences). Use `search_memory` for topical or open-ended recall. Call both when useful. Treat [FACT] results as ground truth and [CONTEXT] results as supporting information.\n\nAttribution matters: when a result's prefix reads `[FACT from <name(s)>]` or `[CONTEXT from <name(s)>]`, that memory came from another agent's conversation with the user — you were not there. Say so naturally: \"According to Finn…\", \"Tess mentioned that…\", \"I checked with Ezra and he said…\", \"I believe you talked to Finn about this — he said…\". Never present another agent's memory as your own recollection. When a result has no `from` attribution, it's ambient memory or your own conversation; speak as yourself without citing anyone.\n\nThe user's memory, tasks, and backlog live in these tools, not in an attachment or document store. Never ask the user to upload, re-upload, or attach anything, and never frame a miss as something not being found in an attachment or files. Memory retrieval is a SILENT background aid: when a memory or file search returns nothing, that is normal — do NOT tell the user you searched, where you looked, or that nothing was found, and never say things like 'I couldn't find', 'no details in the current files', or 'nothing matched'. Answer directly from the live conversation (your and the user's messages in this thread ARE your primary context) and your general knowledge; if you genuinely lack a specific fact they asked for, ask one brief natural clarifying question or offer to note it — without narrating the search.";
