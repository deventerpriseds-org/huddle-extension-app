// Roster block appended to every agent's instructions so agents are aware of
// their teammates and can hand off with @mentions.
import { AGENTS, type AgentId } from "../data/agents";

export function buildRoster(activeMembers: readonly AgentId[], selfId: AgentId): string {
  const others = AGENTS.filter(
    (a) => a.id !== selfId && activeMembers.includes(a.id),
  );
  if (others.length === 0) return "";
  const lines = others.map(
    (a) => `- @${a.handle} — ${a.role}${a.domains.length ? ` (${a.domains.slice(0, 3).join(", ")})` : ""}`,
  );
  return (
    `\n\nTeam roster in this huddle (hand off with @handle when the ask is outside your lane):\n` +
    lines.join("\n")
  );
}
