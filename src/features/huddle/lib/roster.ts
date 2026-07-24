// Roster block appended to every agent's instructions so agents are aware of
// their teammates and can hand off with @mentions. Each teammate line also carries
// any EXCLUSIVE capability they own (data-driven via ownershipMarker), so every agent
// learns who to hand ownership to for any exclusive power — no hardcoded names.
import { AGENTS, type AgentId } from "../data/agents";
import { ownershipMarker } from "./capabilities";

export function buildRoster(activeMembers: readonly AgentId[], selfId: AgentId): string {
  const others = AGENTS.filter(
    (a) => a.id !== selfId && activeMembers.includes(a.id),
  );
  if (others.length === 0) return "";
  const lines = others.map(
    (a) =>
      `- @${a.handle} — ${a.role}${a.domains.length ? ` (${a.domains.slice(0, 3).join(", ")})` : ""}${ownershipMarker(a)}`,
  );
  return (
    `\n\nTeam roster in this huddle (hand off with @handle when the ask is outside your lane; the [owns: …] tag marks an exclusive job only that teammate can do):\n` +
    lines.join("\n")
  );
}
