import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type Agent, type AgentId } from "../data/agents";
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

/**
 * LLM-based router. Picks a primary agent + optional supporting agents based
 * on the user's message and recent history. Falls back to the keyword
 * routeMessage() on any failure so we never block a reply.
 *
 * 1:1 and explicit @mentions short-circuit before this is called.
 */
export interface RouterInvocation {
  backend: "openai" | "lovable";
  model: string;
  fastMode?: boolean;
  /** #1 — tighten the router prompt to prefer a single primary agent. */
  strictPrompt?: boolean;
  /** #2 — drop supporting agents when the primary already covers the message. */
  soloOnCoverage?: boolean;
  /** Lovable AI SDK model instance — required when backend === "lovable". */
  lovableModel?: Parameters<typeof generateText>[0]["model"];
}

export async function routeMessageLLM(
  input: RouteInput,
  invocation: RouterInvocation,
): Promise<RouteResult> {
  const { text, scope, members, history, targetAgentId } = input;
  const present = AGENTS.filter((a) => members.includes(a.id));

  if (scope === "one-to-one" && targetAgentId) return routeMessage(input);
  const mentions = parseMentions(text, present);
  if (mentions.length > 0) return routeMessage(input);

  const memberIds = present.map((a) => a.id) as [AgentId, ...AgentId[]];
  if (memberIds.length === 0) return routeMessage(input);

  const roster = present
    .map((a) => `- ${a.id} (${a.name}, ${a.role}): ${a.domains.join(", ")}`)
    .join("\n");

  const transcript = history
    .slice(-8)
    .filter((m) => m.author.kind !== "system")
    .map((m) => {
      if (m.author.kind === "user") return `User: ${m.text}`;
      const a =
        AGENT_BY_ID[(m.author as { kind: "agent"; agentId: AgentId }).agentId];
      return `${a.name}: ${m.text}`;
    })
    .join("\n");

  const baseSystem = `You are the router for a multi-agent huddle. Choose which agents should respond to the user's latest message based on intent and context — not just keywords. Prefer a single primary agent; add supporting agents only when their expertise is clearly needed. Never invent agent ids — only choose from the roster.`;

  const strictSystem = `You are the router for a multi-agent huddle. Pick exactly ONE primary agent for the user's latest message. Return supporting = [] UNLESS the message explicitly asks for a second, non-overlapping specialty (e.g. "and also budget it" or "then draft the email"). Adjacency is not enough — a workout question does NOT need a life-strategist just because habits are related. When in doubt, return supporting = []. Never invent agent ids — only choose from the roster.

Example — user: "what workouts do i usually go for?" → primary: flex-grimes, supporting: [], reason: single-lane fitness question.
Example — user: "plan tomorrow's workout and also budget my gym membership" → primary: flex-grimes, supporting: [finn-reid], reason: two distinct lanes explicitly named.`;

  const system = invocation.strictPrompt ? strictSystem : baseSystem;

  const supportingHint = invocation.strictPrompt
    ? "Pick the best primary agent. Return supporting = [] unless the message explicitly requires a second specialty."
    : "Pick the best primary agent, up to 2 supporting agents, and a one-line reason.";

  const prompt = `Roster (available agents in this huddle):
${roster}

Recent transcript:
${transcript || "(no prior messages)"}

Latest user message:
${text}

${supportingHint}`;

  const zodSchema = z.object({
    primary: z.enum(memberIds),
    supporting: z.array(z.enum(memberIds)),
    reason: z.string(),
  });

  try {
    let output: { primary: AgentId; supporting: AgentId[]; reason: string };

    if (invocation.backend === "openai") {
      const { callOpenAIRouter } = await import("./openai-responses.server");
      // Build a strict JSON schema mirroring the Zod shape.
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
          primary: { type: "string", enum: memberIds },
          supporting: {
            type: "array",
            items: { type: "string", enum: memberIds },
          },
          reason: { type: "string" },
        },
        required: ["primary", "supporting", "reason"],
      } as Record<string, unknown>;

      const raw = await callOpenAIRouter<{
        primary: string;
        supporting: string[];
        reason: string;
      }>({
        model: invocation.model,
        system,
        prompt,
        schema: jsonSchema,
        schemaName: "huddle_route",
        fastMode: invocation.fastMode,
      });
      output = zodSchema.parse(raw);
    } else {
      if (!invocation.lovableModel) throw new Error("Lovable model not initialized");
      const result = await generateText({
        model: invocation.lovableModel,
        system,
        prompt,
        output: Output.object({ schema: zodSchema }),
      });
      output = result.output;
    }

    const { primary, supporting, reason } = output;

    if (!memberIds.includes(primary)) {
      console.error(
        "[huddle-router] LLM returned primary not in roster, using keyword fallback:",
        { primary, memberIds },
      );
      const fallback = routeMessage(input);
      return {
        ...fallback,
        decision: {
          ...fallback.decision,
          reason: `LLM fallback: primary "${primary}" not in roster. ${fallback.decision.reason}`,
        },
      };
    }

    const winners: AgentId[] = [primary];
    for (const id of supporting) {
      if (
        memberIds.includes(id) &&
        id !== primary &&
        !winners.includes(id) &&
        winners.length < 3
      ) {
        winners.push(id);
      }
    }
    const scores = Object.fromEntries(
      winners.map((id, i) => [id, Number((1 - i * 0.2).toFixed(2))]),
    ) as Partial<Record<AgentId, number>>;

    return {
      winners,
      decision: {
        signal: "topic",
        scores,
        winnerId: primary,
        runnerUpId: winners[1] ?? null,
        interjected: true,
        reason: `LLM router (${invocation.backend}/${invocation.model}): ${reason}`.slice(0, 220),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (NoObjectGeneratedError.isInstance(err)) {
      console.error(
        "[huddle-router] LLM router failed (NoObjectGenerated), using keyword fallback:",
        msg,
        "raw:",
        err.text,
      );
    } else {
      console.error(
        "[huddle-router] LLM router failed, using keyword fallback:",
        msg,
      );
    }
    const fallback = routeMessage(input);
    return {
      ...fallback,
      decision: {
        ...fallback.decision,
        reason: `LLM fallback: ${msg.slice(0, 120)}. ${fallback.decision.reason}`,
      },
    };
  }
}

