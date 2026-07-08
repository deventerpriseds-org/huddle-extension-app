import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage } from "../data/seed";
import { routeMessage } from "./routing";

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

const Input = z.object({
  text: z.string().min(1).max(4000),
  huddleId: z.string(),
  scope: z.enum(["one-to-one", "group"]),
  members: z.array(z.enum(AgentIds)).min(1),
  history: z.array(HistoryMessage).max(40),
  targetAgentId: z.enum(AgentIds).optional(),
});

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => {
    const routed = routeMessage({
      text: data.text,
      scope: data.scope,
      members: data.members,
      history: data.history as HuddleMessage[],
      targetAgentId: data.targetAgentId,
    });

    if (!routed.winnerId) {
      return {
        decision: routed.decision,
        reply: null as null | { agentId: AgentId; text: string },
      };
    }

    const winner = AGENT_BY_ID[routed.winnerId];
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return {
        decision: routed.decision,
        reply: {
          agentId: winner.id,
          text: "AI gateway is not configured yet — placeholder reply.",
        },
      };
    }

    const { createLovableAiGatewayProvider } = await import("@/lib/ai-gateway.server");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("openai/gpt-5.5");

    const system =
      winner.systemPrompt +
      ` You are inside a ${data.scope === "group" ? "group huddle with multiple agents present" : "one-to-one huddle with the user"}. Never break character. Do not answer as another agent. If a task should be tracked, mention it in one line at most.`;

    const transcript = data.history
      .slice(-14)
      .map((m) => {
        if (m.author.kind === "user") return { role: "user" as const, content: m.text };
        if (m.author.kind === "agent") {
          const a = AGENT_BY_ID[m.author.agentId];
          const tag = a.id === winner.id ? "" : `[${a.name}] `;
          return { role: "assistant" as const, content: tag + m.text };
        }
        return { role: "system" as const, content: `(event) ${m.text}` };
      })
      .concat([{ role: "user" as const, content: data.text }]);

    try {
      const { text } = await generateText({
        model,
        system,
        messages: transcript,
      });
      return {
        decision: routed.decision,
        reply: { agentId: winner.id, text: text.trim() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI gateway error";
      return {
        decision: routed.decision,
        reply: { agentId: winner.id, text: `(couldn't reach the model — ${msg})` },
      };
    }
  });
