// WHAT:          The ONE memory-retrieval step every agent surface uses: fetch shared memory for the user's
//                message, drop weak and already-visible hits, rank the agent's own topics first, collapse
//                near-duplicates. Text chat (runAgentTurn) and the voice call (assembleRealtimeInstructions)
//                both call retrieveAgentMemory; each only chooses how to word the block it injects.
// WHY:           Voice had its own copy (k=5, no relevance floor, no topic ranking, no dedup), so a spoken
//                1:1 recalled differently from a typed one. Owner, 2026-10-28: "I don't understand why
//                voice can't trigger the same jobs instead of needing to be configured separately."
// SUPERSEDES:    the inline block in huddle.functions.ts runAgentTurn and the raw searchChunks call in
//                voice/realtime-tools.server.ts (both now call this; neither copy remains).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/memory-context.test.ts (selection rules + both surfaces call this module).

import type { ChunkRow, SharingMode } from "./types";

// How many CANDIDATES the DB returns, and how many survive into the prompt. Split on purpose: fetching
// wide is cheap (one ANN query) while injecting wide is not -- every extra chunk rides in the agent's
// prompt on every turn. 20 is the server-side clamp ceiling (azure-pg.server.ts): the SQL LIMIT is this k,
// so a smaller k makes anything the ANN ranked lower unreachable however relevant it is.
export const MEMORY_CANDIDATE_K = 20;
export const MEMORY_INJECT_N = 8;
// Relevance floor calibrated for text-embedding-3-large, whose cosine scores run LOW: a strong topical
// match ("what is my dog's name?" vs "my dog's name is Waffles") measures ~0.42; unrelated text sits
// below ~0.25. 0.3 keeps genuine matches and rejects noise.
export const MEMORY_MIN_SCORE = 0.3;

export interface MemoryAgent {
  id: string;
  domains: string[];
  themes: string[];
}

/**
 * Pure selection over already-fetched candidates (no I/O, so it is unit-testable):
 *  - relevance floor, and drop anything the agent can already see (the message + recent transcript);
 *  - topic ranking: within the floor, gently prefer chunks that mention this agent's domains/themes
 *    (+0.12) or that it co-authored (+0.06) -- a reorder, never a filter, so every agent can still see
 *    everything (owner's choice 2026-10-27: soft preference, not lane isolation);
 *  - near-duplicate collapse on an 80-char normalized prefix (whole-string matching cannot catch two
 *    chunks that differ only by a task title inside identical boilerplate);
 *  - cap at MEMORY_INJECT_N.
 */
export function selectMemoryHits(
  hits: ChunkRow[],
  agent: MemoryAgent,
  alreadyVisible: Iterable<string> = [],
): ChunkRow[] {
  const visible = new Set([...alreadyVisible].map((t) => t.trim()));
  const laneTerms = [...agent.domains, ...agent.themes].map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const laneBoost = (h: ChunkRow) => {
    const t = (h.text || "").toLowerCase();
    const termHit = laneTerms.some((kw) => t.includes(kw)) ? 0.12 : 0;
    const authorHit = h.authorAgentIds?.includes(agent.id) ? 0.06 : 0;
    return termHit + authorHit;
  };
  const seenPrefix = new Set<string>();
  return hits
    .filter((h) => (h.score ?? 0) >= MEMORY_MIN_SCORE && !visible.has(h.text.trim()))
    .sort((a, b) => (b.score ?? 0) + laneBoost(b) - ((a.score ?? 0) + laneBoost(a)))
    .filter((h) => {
      const key = h.text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
      if (seenPrefix.has(key)) return false;
      seenPrefix.add(key);
      return true;
    })
    .slice(0, MEMORY_INJECT_N);
}

/** Fetch + select. Throws on a store/embedding failure; callers treat memory as best-effort. */
export async function retrieveAgentMemory(input: {
  query: string;
  agent: MemoryAgent;
  mode?: SharingMode;
  queryVec?: number[];
  alreadyVisible?: Iterable<string>;
}): Promise<ChunkRow[]> {
  const { azurePgStore } = await import("./azure-pg.server");
  const hits = await azurePgStore.searchChunks({
    query: input.query,
    queryVec: input.queryVec,
    agentId: input.agent.id,
    mode: input.mode ?? "shared",
    k: MEMORY_CANDIDATE_K,
  });
  const fresh = selectMemoryHits(hits ?? [], input.agent, input.alreadyVisible ?? [input.query]);
  console.info(
    `[memory] agent=${input.agent.id} candidates=${(hits ?? []).length} injected=${fresh.length} ` +
      `topScore=${(hits?.[0]?.score ?? 0).toFixed(3)}`,
  );
  return fresh;
}
