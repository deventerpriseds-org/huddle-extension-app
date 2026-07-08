import { AGENTS, type Agent, type AgentId } from "../data/agents";
import type { HuddleMessage, RoutingDecision } from "../data/seed";

const THRESHOLD_GROUP = 0.32;
const THRESHOLD_ONE_TO_ONE = 0;

// crude bag-of-words scoring against agent domains + themes
function scoreAgentAgainst(text: string, agent: Agent): number {
  const t = text.toLowerCase();
  let hits = 0;
  let total = 0;
  for (const kw of [...agent.domains, ...agent.themes]) {
    total += 1;
    const needle = kw.toLowerCase();
    if (t.includes(needle)) hits += 2;
    else {
      // token match on first word of the theme
      const first = needle.split(/\s+/)[0];
      if (first.length > 3 && new RegExp(`\\b${first}`).test(t)) hits += 1;
    }
  }
  // also boost on role first word
  if (t.includes(agent.role.toLowerCase().split(" ")[0])) hits += 1;
  const raw = hits / Math.max(6, total);
  return Math.min(1, raw);
}

export function parseMentions(text: string, agents: Agent[]): AgentId[] {
  const found = new Set<AgentId>();
  const lower = text.toLowerCase();
  for (const a of agents) {
    const handle = `@${a.handle}`;
    const firstName = a.name.split(" ")[0].toLowerCase();
    if (lower.includes(handle)) found.add(a.id);
    else if (new RegExp(`@${firstName}\\b`, "i").test(text)) found.add(a.id);
  }
  return [...found];
}

export interface RouteInput {
  text: string;
  scope: "one-to-one" | "group" | "call";
  members: AgentId[]; // agents present in the huddle
  history: HuddleMessage[]; // recent, oldest first
  targetAgentId?: AgentId; // for 1:1 (always answers)
}

export interface RouteResult {
  decision: Omit<RoutingDecision, "id" | "messageId" | "ts">;
  winnerId: AgentId | null;
}

export function routeMessage(input: RouteInput): RouteResult {
  const { text, scope, members, history, targetAgentId } = input;
  const present = AGENTS.filter((a) => members.includes(a.id));

  // 1:1 — the target agent always answers
  if (scope === "one-to-one" && targetAgentId) {
    return {
      winnerId: targetAgentId,
      decision: {
        signal: "mention",
        scores: { [targetAgentId]: 1 },
        winnerId: targetAgentId,
        runnerUpId: null,
        interjected: false,
        reason: "1:1 huddle — direct conversation with the agent.",
      },
    };
  }

  // 1. explicit @mention
  const mentions = parseMentions(text, present);
  if (mentions.length > 0) {
    const winner = mentions[0];
    return {
      winnerId: winner,
      decision: {
        signal: "mention",
        scores: Object.fromEntries(mentions.map((m) => [m, 1])) as Partial<Record<AgentId, number>>,
        winnerId: winner,
        runnerUpId: mentions[1] ?? null,
        interjected: false,
        reason: `Explicit mention of @${winner}.`,
      },
    };
  }

  // 2. reply / last-addressed agent (walk back 3 turns)
  const last = [...history].reverse().slice(0, 6);
  const lastAgentTurn = last.find((m) => m.author.kind === "agent");
  if (lastAgentTurn && lastAgentTurn.author.kind === "agent") {
    // small boost — only wins if topic doesn't strongly disagree
    const holder = lastAgentTurn.author.agentId;
    const holderAgent = present.find((a) => a.id === holder);
    if (holderAgent) {
      const holderScore = 0.55 + scoreAgentAgainst(text, holderAgent) * 0.4;
      const scores: Partial<Record<AgentId, number>> = {};
      let bestOther: { id: AgentId; s: number } | null = null;
      for (const a of present) {
        const s = a.id === holder ? holderScore : scoreAgentAgainst(text, a);
        scores[a.id] = Number(s.toFixed(2));
        if (a.id !== holder && (!bestOther || s > bestOther.s)) bestOther = { id: a.id, s };
      }
      // If another agent decisively beats the holder, defer to topic route below
      if (!bestOther || holderScore >= bestOther.s - 0.15) {
        return {
          winnerId: holder,
          decision: {
            signal: "reply",
            scores,
            winnerId: holder,
            runnerUpId: bestOther?.id ?? null,
            interjected: false,
            reason: `Reply/thread context — ${holderAgent.name} kept the floor.`,
          },
        };
      }
    }
  }

  // 3. topic & theme relevance
  const scores: Partial<Record<AgentId, number>> = {};
  const ranked: Array<{ id: AgentId; s: number }> = [];
  for (const a of present) {
    const s = scoreAgentAgainst(text, a);
    scores[a.id] = Number(s.toFixed(2));
    ranked.push({ id: a.id, s });
  }
  ranked.sort((a, b) => b.s - a.s);
  const T = scope === "group" ? THRESHOLD_GROUP : THRESHOLD_ONE_TO_ONE;
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top && top.s >= T && (!runnerUp || top.s - runnerUp.s >= 0.06)) {
    return {
      winnerId: top.id,
      decision: {
        signal: "topic",
        scores,
        winnerId: top.id,
        runnerUpId: runnerUp?.id ?? null,
        interjected: true,
        reason: `Topic relevance — score ${top.s.toFixed(2)} ≥ τ ${T}.`,
      },
    };
  }

  // 4. floor — coordinator fallback
  const coordinator = present.find((a) => a.special === "coordinator") ?? present.find((a) => a.special === "standup-host");
  const winner = coordinator?.id ?? null;
  return {
    winnerId: winner,
    decision: {
      signal: "floor",
      scores,
      winnerId: winner,
      runnerUpId: top?.id ?? null,
      interjected: false,
      reason: "No clear match — coordinator picks up.",
    },
  };
}
