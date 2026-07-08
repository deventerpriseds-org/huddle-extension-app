import { AGENTS, type Agent, type AgentId } from "../data/agents";
import type { HuddleMessage, RoutingDecision } from "../data/seed";

// stem match — first 5 chars, word-boundary
function stem(w: string) {
  return w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
}
function tokens(text: string) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreAgentAgainst(text: string, agent: Agent): number {
  const textTokens = tokens(text);
  const textStems = new Set(textTokens.map(stem).filter((s) => s.length >= 3));
  let hits = 0;
  let total = 0;
  // domains carry more weight than themes/role
  const weighted: Array<{ kw: string; w: number }> = [
    ...agent.domains.map((kw) => ({ kw, w: 3 })),
    ...agent.themes.map((kw) => ({ kw, w: 1 })),
    { kw: agent.role, w: 1 },
  ];
  for (const { kw, w } of weighted) {
    for (const part of kw.split(/\s+/)) {
      const s = stem(part);
      if (s.length < 3) continue;
      total += w;
      if (textStems.has(s)) hits += w * 2;
    }
  }
  const raw = hits / Math.max(8, total);
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
  members: AgentId[];
  history: HuddleMessage[];
  targetAgentId?: AgentId;
}

export interface RouteResult {
  decision: Omit<RoutingDecision, "id" | "messageId" | "ts">;
  winners: AgentId[]; // ordered; primary first
}

export function routeMessage(input: RouteInput): RouteResult {
  const { text, scope, members, history, targetAgentId } = input;
  const present = AGENTS.filter((a) => members.includes(a.id));

  // 1:1 — target always answers
  if (scope === "one-to-one" && targetAgentId) {
    return {
      winners: [targetAgentId],
      decision: {
        signal: "mention",
        scores: { [targetAgentId]: 1 },
        winnerId: targetAgentId,
        runnerUpId: null,
        interjected: false,
        reason: "1:1",
      },
    };
  }

  // 1. explicit @mentions — all mentioned agents answer
  const mentions = parseMentions(text, present);
  if (mentions.length > 0) {
    return {
      winners: mentions.slice(0, 3),
      decision: {
        signal: "mention",
        scores: Object.fromEntries(mentions.map((m) => [m, 1])) as Partial<Record<AgentId, number>>,
        winnerId: mentions[0],
        runnerUpId: mentions[1] ?? null,
        interjected: false,
        reason: `Explicit mention.`,
      },
    };
  }

  // Score all present agents by topic
  const scores: Partial<Record<AgentId, number>> = {};
  const ranked: Array<{ id: AgentId; s: number }> = [];
  for (const a of present) {
    const s = scoreAgentAgainst(text, a);
    scores[a.id] = Number(s.toFixed(2));
    ranked.push({ id: a.id, s });
  }
  ranked.sort((a, b) => b.s - a.s);

  // 2. reply/thread stickiness — last agent turn keeps floor unless topic strongly points elsewhere
  const last = [...history].reverse().slice(0, 6);
  const lastAgentTurn = last.find((m) => m.author.kind === "agent");
  if (lastAgentTurn && lastAgentTurn.author.kind === "agent") {
    const holder = lastAgentTurn.author.agentId;
    const holderRank = ranked.find((r) => r.id === holder);
    const top = ranked[0];
    if (holderRank && top && (holderRank.s >= top.s - 0.1 || top.s < 0.1)) {
      const runner = ranked.find((r) => r.id !== holder);
      const winners: AgentId[] = [holder];
      if (runner && runner.s >= 0.2 && runner.s >= (holderRank.s - 0.15)) winners.push(runner.id);
      return {
        winners,
        decision: {
          signal: "reply",
          scores,
          winnerId: holder,
          runnerUpId: runner?.id ?? null,
          interjected: false,
          reason: "Thread continuation.",
        },
      };
    }
  }

  // 3. topic — take the top scorer plus any close runner-up
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top && top.s > 0) {
    const winners: AgentId[] = [top.id];
    if (runnerUp && runnerUp.s >= 0.2 && top.s - runnerUp.s <= 0.15) {
      winners.push(runnerUp.id);
    }
    return {
      winners,
      decision: {
        signal: "topic",
        scores,
        winnerId: top.id,
        runnerUpId: runnerUp?.id ?? null,
        interjected: true,
        reason: `Topic match.`,
      },
    };
  }

  // 4. floor — team lead (Terry) picks it up as a person, not a router
  const lead =
    present.find((a) => a.special === "standup-host") ??
    present.find((a) => a.special === "coordinator") ??
    present[0];
  return {
    winners: lead ? [lead.id] : [],
    decision: {
      signal: "floor",
      scores,
      winnerId: lead?.id ?? null,
      runnerUpId: top?.id ?? null,
      interjected: false,
      reason: "Open floor.",
    },
  };
}
