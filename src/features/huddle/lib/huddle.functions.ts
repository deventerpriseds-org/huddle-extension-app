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

    type Reply = { agentId: AgentId; text: string };

    if (routed.winners.length === 0) {
      return { decision: routed.decision, replies: [] as Reply[] };
    }

    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return {
        decision: routed.decision,
        replies: routed.winners.map((id) => ({
          agentId: id,
          text: "AI gateway is not configured yet.",
        })),
      };
    }

    const { createLovableAiGatewayProvider } = await import("@/lib/ai-gateway.server");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("openai/gpt-5.5");

    const baseTranscript = data.history
      .slice(-14)
      .filter((m) => m.author.kind !== "system")
      .map((m) => {
        if (m.author.kind === "user") return { role: "user" as const, content: m.text };
        const a = AGENT_BY_ID[(m.author as { kind: "agent"; agentId: AgentId }).agentId];
        return { role: "assistant" as const, content: `[${a.name}] ${m.text}` };
      })
      .concat([{ role: "user" as const, content: data.text }]);

    const replies: Reply[] = [];
    for (let i = 0; i < routed.winners.length; i++) {
      const winner = AGENT_BY_ID[routed.winners[i]];
      const priorInThisTurn = replies
        .map((r) => `${AGENT_BY_ID[r.agentId].name} just said: "${r.text}"`)
        .join("\n");
      const system =
        winner.systemPrompt +
        ` You are ${winner.name} in a ${data.scope === "group" ? "group huddle" : "1:1"}. Reply naturally, as yourself, in-character — like you're talking in a room with real people. Never announce routing or say you'll pass it to another agent; just answer. Do not speak as anyone else. 1–3 short sentences unless asked for detail.` +
        (priorInThisTurn ? `\n\nOther agents just replied in this same turn:\n${priorInThisTurn}\nBuild on what they said instead of repeating it. If you have nothing to add, reply with a single short line.` : "");

      try {
        const { text } = await generateText({
          model,
          system,
          messages: baseTranscript,
        });
        const clean = text.trim();
        if (clean) replies.push({ agentId: winner.id, text: clean });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI gateway error";
        replies.push({ agentId: winner.id, text: `(couldn't reach the model — ${msg})` });
      }
    }

    return { decision: routed.decision, replies };
  });

