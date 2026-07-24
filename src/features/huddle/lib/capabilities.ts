// Ownership backbone — everything about "who exclusively owns what" is derived HERE
// from `agent.capabilities` in agents.ts, never from a hardcoded name. The roster
// surfaced to every agent, the router's ownership rule, the scope-aware hand-off
// behaviour, and the exclusive-tool gating all read these helpers, so adding a
// capability to any agent (or a new agent that owns one) works across the whole
// roster with zero per-case code. See AgentCapability in agents.ts.
import { AGENTS, type Agent, type AgentCapability, type AgentId } from "../data/agents";

export interface OwnedCapability {
  agent: Agent;
  cap: AgentCapability;
}

/** True if `agent` owns the capability `capId` (any capability; exclusive or not). */
export function agentOwnsCapability(agent: Agent | undefined, capId: string): boolean {
  return !!agent?.capabilities?.some((c) => c.id === capId);
}

/** The agents that own an EXCLUSIVE capability (restricted to `members` when given). */
export function exclusiveCapabilities(members?: readonly AgentId[]): OwnedCapability[] {
  const inScope = members ? new Set(members) : null;
  const out: OwnedCapability[] = [];
  for (const agent of AGENTS) {
    if (inScope && !inScope.has(agent.id)) continue;
    for (const cap of agent.capabilities ?? []) {
      if (cap.exclusive) out.push({ agent, cap });
    }
  }
  return out;
}

/** The owner agent of an exclusive capability id, if present in `members` (or the whole roster). */
export function ownerOfCapability(
  capId: string,
  members?: readonly AgentId[],
): Agent | undefined {
  return exclusiveCapabilities(members).find((o) => o.cap.id === capId)?.agent;
}

/** The exclusive-capability markers for a single agent's roster line, e.g. " [owns: backlog grooming …]". */
export function ownershipMarker(agent: Agent): string {
  const owned = (agent.capabilities ?? []).filter((c) => c.exclusive);
  return owned.length ? ` [owns: ${owned.map((c) => c.label).join("; ")}]` : "";
}

/**
 * A compact ownership directory for prompts:
 *   "- backlog grooming, triage & sprint/board assignment → @terry-locke"
 * Restricted to the exclusive owners present in this huddle. Empty string when none.
 */
export function ownershipDirectory(members: readonly AgentId[]): string {
  const owned = exclusiveCapabilities(members);
  if (!owned.length) return "";
  return owned.map((o) => `- ${o.cap.label} → @${o.agent.handle}`).join("\n");
}
