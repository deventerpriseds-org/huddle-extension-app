import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage } from "../data/seed";
import { parseMentions, routeMessage, routeMessageLLM, type RouterInvocation } from "./routing";

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

const HistoryMessage = z.object({
  id: z.string(),
  huddleId: z.string(),
  author: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user") }),
    z.object({ kind: z.literal("agent"), agentId: z.enum(AgentIds) }),
    z.object({ kind: z.literal("system") }),
  ]),
  text: z.string(),
  ts: z.number(),
  mentions: z.array(z.enum(AgentIds)).optional(),
  replyTo: z.string().optional(),
});

const RouterConfigInput = z.object({
  backend: z.enum(["openai", "lovable"]),
  model: z.string().min(1),
  fastMode: z.boolean().optional(),
});

const AgentBackendInput = z.object({
  backend: z.enum(["lovable", "openai"]),
  assistantId: z.string().optional(),
  useStoredPrompt: z.boolean(),
});

const Input = z.object({
  text: z.string().min(1).max(4000),
  huddleId: z.string(),
  scope: z.enum(["one-to-one", "group"]),
  members: z.array(z.enum(AgentIds)).min(1),
  history: z.array(HistoryMessage).max(40),
  targetAgentId: z.enum(AgentIds).optional(),
  router: RouterConfigInput.optional(),
  agents: z.record(z.enum(AgentIds), AgentBackendInput).optional(),
});

const MAX_REPLIES_PER_TURN = 4;

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    type Reply = { agentId: AgentId; text: string };

    const routerCfg = data.router ?? { backend: "openai" as const, model: "gpt-5.5", fastMode: false };
    const agentsCfg = data.agents ?? {};

    // Lovable AI SDK model — created lazily only when something needs it.
    let lovableModel: Parameters<typeof generateText>[0]["model"] | null = null;
    async function getLovableModel(id: string) {
      if (!lovableKey) return null;
      if (!lovableModel) {
        const { createLovableAiGatewayProvider } = await import("@/lib/ai-gateway.server");
        const gateway = createLovableAiGatewayProvider(lovableKey, undefined, {
          structuredOutputs: true,
        });
        lovableModel = gateway(id);
      }
      return lovableModel;
    }

    // ---- Route ----
    const explicitMentions = parseMentions(
      data.text,
      AGENTS.filter((a) => data.members.includes(a.id)),
    );
    const canLLMRoute =
      data.scope === "group" &&
      !data.targetAgentId &&
      explicitMentions.length === 0 &&
      (routerCfg.backend === "openai" ? !!openaiKey : !!lovableKey);

    let routed;
    if (canLLMRoute) {
      const invocation: RouterInvocation = {
        backend: routerCfg.backend,
        model: routerCfg.model,
        fastMode: routerCfg.fastMode,
      };
      if (routerCfg.backend === "lovable") {
        const m = await getLovableModel(routerCfg.model);
        if (m) invocation.lovableModel = m;
      }
      routed = await routeMessageLLM(
        {
          text: data.text,
          scope: data.scope,
          members: data.members,
          history: data.history as HuddleMessage[],
          targetAgentId: data.targetAgentId,
        },
        invocation,
      );
    } else {
      routed = routeMessage({
        text: data.text,
        scope: data.scope,
        members: data.members,
        history: data.history as HuddleMessage[],
        targetAgentId: data.targetAgentId,
      });
    }

    if (routed.winners.length === 0) {
      return { decision: routed.decision, replies: [] as Reply[] };
    }

    // ---- Reply transcript ----
    const baseTranscript = data.history
      .slice(-14)
      .filter((m) => m.author.kind !== "system")
      .map((m) => {
        if (m.author.kind === "user") return { role: "user" as const, content: m.text };
        const a = AGENT_BY_ID[(m.author as { kind: "agent"; agentId: AgentId }).agentId];
        return { role: "assistant" as const, content: `[${a.name}] ${m.text}` };
      })
      .concat([{ role: "user" as const, content: data.text }]);

    const presentAgents = AGENTS.filter((a) => data.members.includes(a.id));

    const queue: AgentId[] = [...routed.winners];
    const spoken = new Set<AgentId>();
    const replies: Reply[] = [];

    while (queue.length > 0 && replies.length < MAX_REPLIES_PER_TURN) {
      const nextId = queue.shift()!;
      if (spoken.has(nextId)) continue;
      const winner = AGENT_BY_ID[nextId];
      if (!winner || !data.members.includes(nextId)) continue;

      const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const, useStoredPrompt: false };

      const priorInThisTurn = replies
        .map((r) => `${AGENT_BY_ID[r.agentId].name} just said: "${r.text}"`)
        .join("\n");

      const appSystem =
        winner.systemPrompt +
        ` You are ${winner.name} in a ${data.scope === "group" ? "group huddle" : "1:1"}. Reply naturally, as yourself, in-character — like you're talking in a room with real people. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to". Do not speak as anyone else. 1–3 short sentences unless asked for detail.` +
        (priorInThisTurn
          ? `\n\nOther agents just replied in this same turn:\n${priorInThisTurn}\nBuild on what they said instead of repeating it. If you have nothing to add, reply with a single short line.`
          : "");

      try {
        let clean = "";

        if (agentBackend.backend === "openai" && agentBackend.assistantId && openaiKey) {
          const { callOpenAIResponses } = await import("./openai-responses.server");
          const text = await callOpenAIResponses({
            assistantId: agentBackend.assistantId,
            instructions: agentBackend.useStoredPrompt ? undefined : appSystem,
            transcript: baseTranscript,
            fastMode: routerCfg.fastMode,
          });
          clean = text.trim();
        } else {
          // Lovable AI path (default fallback).
          const model = await getLovableModel("openai/gpt-5.5");
          if (!model) {
            replies.push({ agentId: winner.id, text: "AI gateway is not configured yet." });
            spoken.add(winner.id);
            continue;
          }
          const { text } = await generateText({
            model,
            system: appSystem,
            messages: baseTranscript,
          });
          clean = text.trim();
        }

        if (!clean) continue;
        replies.push({ agentId: winner.id, text: clean });
        spoken.add(winner.id);

        const chained = parseMentions(clean, presentAgents);
        for (const id of chained) {
          if (
            id !== winner.id &&
            !spoken.has(id) &&
            !queue.includes(id) &&
            data.members.includes(id)
          ) {
            queue.push(id);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI error";
        replies.push({
          agentId: winner.id,
          text: `(couldn't reach the model — ${msg})`,
        });
        spoken.add(winner.id);
      }
    }

    return { decision: routed.decision, replies };
  });
