// Knowledge library registry — the "specialized brain" layer, wired the same
// roster-driven way the rest of Huddle is (routing, capabilities): DATA is the
// source of truth, not a hand-maintained lookup.
//
// A pack declares WHICH agent it belongs to in its own `agentId` field. The
// lookup map is BUILT from that field, so an id is written exactly once (in the
// pack) — there is no separate object key to drift out of sync. Consequences for
// the questions that matter:
//   • Add an agent  → it simply has no pack until one is authored; the runtime
//     returns "" for it and the persona/snapshot still works. Authoring is one
//     file + one line in ALL_PACKS below — knowledge is written content, it can't
//     be generated, but there is no second wiring step.
//   • Rename an id  → `agentId: AgentId` is a typed union, so the stale id fails
//     to COMPILE. Renames surface immediately instead of silently mismatching.
//   • Remove an agent → same compile error on the orphaned pack; and
//     `validateKnowledgePacks()` (run in scripts/knowledge.test.ts) catches
//     orphans + duplicates at test time as a second net.
import { AGENTS, type AgentId } from "../agents";
import type { KnowledgePack } from "./types";

import { finnReidKnowledge } from "./finn-reid.knowledge";
import { samTrentKnowledge } from "./sam-trent.knowledge";
import { tessSuttonKnowledge } from "./tess-sutton.knowledge";
import { terryLockeKnowledge } from "./terry-locke.knowledge";

export type { KnowledgePack } from "./types";
export { renderKnowledgePack } from "./types";

// The authored packs. Adding a brain = author the file + add it here. Order and
// batching are documentation only — the map is keyed off each pack's agentId.
// Batch 1 — highest-leverage professional lanes (finance, startup, product, agile).
export const ALL_PACKS: readonly KnowledgePack[] = [
  finnReidKnowledge,
  samTrentKnowledge,
  tessSuttonKnowledge,
  terryLockeKnowledge,
];

/** id → pack, built from each pack's own agentId (single source of truth). */
export const KNOWLEDGE_PACKS: Partial<Record<AgentId, KnowledgePack>> = Object.fromEntries(
  ALL_PACKS.map((p) => [p.agentId, p]),
) as Partial<Record<AgentId, KnowledgePack>>;

/**
 * Integrity check for the registry, decoupled from TypeScript so add/rename/remove
 * mistakes that slip past the compiler still fail a test:
 *  - every pack points at a real, current agent (catches a removed/renamed id whose
 *    field wasn't updated),
 *  - no two packs claim the same agent (catches a copy-paste duplicate).
 * Returns the problems (empty array = healthy) plus coverage for the batch ledger.
 */
export function validateKnowledgePacks(): {
  problems: string[];
  covered: AgentId[];
  uncovered: AgentId[];
} {
  const validIds = new Set(AGENTS.map((a) => a.id));
  const problems: string[] = [];
  const seen = new Set<AgentId>();
  for (const p of ALL_PACKS) {
    if (!validIds.has(p.agentId)) {
      problems.push(`knowledge pack references unknown/removed agent id "${p.agentId}"`);
    }
    if (seen.has(p.agentId)) {
      problems.push(`duplicate knowledge pack for agent id "${p.agentId}"`);
    }
    seen.add(p.agentId);
  }
  const covered = AGENTS.filter((a) => seen.has(a.id)).map((a) => a.id);
  const uncovered = AGENTS.filter((a) => !seen.has(a.id)).map((a) => a.id);
  return { problems, covered, uncovered };
}
