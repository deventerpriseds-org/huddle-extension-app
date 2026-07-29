// Knowledge-library accessor — the runtime's single entry point to the "specialized
// brain" layer. Mirrors lib/capabilities.ts: all knowledge is DATA in
// data/knowledge/, and every consumer reads it through here, so wiring a new
// agent's pack needs no change at the call sites.
//
// The returned block is STABLE per agent (independent of the turn), so it is
// injected into the stable/cacheable prefix of the prompt on BOTH instruction
// branches (OpenAI Responses `stableInstructions` and the fallback `appSystem`) —
// the same both-branches discipline the memory block follows (see CLAUDE.md).
import type { AgentId } from "../data/agents";
import { KNOWLEDGE_PACKS, renderKnowledgePack } from "../data/knowledge";

/**
 * The rendered knowledge-base instruction block for an agent, or "" if the agent
 * has no pack yet. Safe to concatenate unconditionally into an instruction string.
 */
export function knowledgeBlockFor(agentId: AgentId): string {
  const pack = KNOWLEDGE_PACKS[agentId];
  return pack ? renderKnowledgePack(pack) : "";
}

/** True if the agent has a knowledge pack authored. */
export function hasKnowledgePack(agentId: AgentId): boolean {
  return !!KNOWLEDGE_PACKS[agentId];
}
