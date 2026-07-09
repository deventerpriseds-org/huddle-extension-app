import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage } from "../data/seed";
import { parseMentions, routeMessage, routeMessageLLM, type RouterInvocation } from "./routing";
import type { FallbackEvent, PromptDebug } from "./fallbacks";
import { buildRoster } from "./roster";


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
  strictPrompt: z.boolean().optional(),
  soloOnCoverage: z.boolean().optional(),
});

const AgentBackendInput = z.object({
  backend: z.enum(["lovable", "openai"]),
  assistantId: z.string().optional(),
  model: z.string().optional(),
  rag: z
    .object({
      store: z.enum(["azure", "lovable", "none"]),
      chunks: z.boolean(),
      triples: z.boolean(),
      fileSearch: z.boolean(),
      openaiVectorStoreId: z.string().optional(),
      sharing: z.enum(["shared", "private", "readonly-shared"]).default("shared"),
    })
    .optional(),
  journey: z.object({ enabled: z.boolean() }).optional(),
  webSearch: z.boolean().optional(),
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
  // Optional caller identity so journey-voice can resolve a Supabase user.
  // Populated from the signed-in Entra account (email / oid) on the client.
  caller: z
    .object({
      entra_object_id: z.string().optional(),
      entra_email: z.string().optional(),
    })
    .optional(),
});

const MAX_REPLIES_PER_TURN = 4;

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    type Reply = { agentId: AgentId; text: string; fallbackNotes?: string[] };

    // Journey-voice mirror: any task rows that journey returns from a tool call
    // are accumulated here and returned to the client so the huddle board can
    // upsert them.
    const journeyTaskUpdates: import("./journey/types").JourneyTask[] = [];

    // Lazy: fetch & cache journey tool definitions for this whole turn. Only
    // populated when at least one participating agent has journey.enabled.
    let journeyToolsCache:
      | { defs: import("./journey/types").JourneyToolDefinition[]; tools: unknown[] }
      | null = null;
    let journeyToolsError: string | null = null;
    const journeyEnabledMembers = data.members.filter(
      (id) => (data.agents ?? {})[id]?.journey?.enabled,
    );
    async function ensureJourneyTools() {
      if (journeyToolsCache || journeyToolsError) return journeyToolsCache;
      if (journeyEnabledMembers.length === 0) return null;
      try {
        const { fetchJourneyToolDefinitions, toResponsesTool } = await import(
          "./journey/proxy.functions"
        );
        const defs = await fetchJourneyToolDefinitions();
        journeyToolsCache = { defs, tools: defs.map(toResponsesTool) };
        return journeyToolsCache;
      } catch (err) {
        journeyToolsError = err instanceof Error ? err.message : String(err);
        return null;
      }
    }

    const routerCfg = data.router ?? { backend: "openai" as const, model: "gpt-5.5", fastMode: false };
    const agentsCfg = data.agents ?? {};

    // ---- Fallback + prompt trackers ----
    const fallbacks: FallbackEvent[] = [];
    const prompts: PromptDebug[] = [];
    let fbSeq = 0;
    function recordFallback(
      subsystem: FallbackEvent["subsystem"],
      reason: string,
      inline: string,
      agentId?: AgentId,
    ): FallbackEvent {
      const ev: FallbackEvent = {
        id: `fb-${Date.now()}-${fbSeq++}`,
        ts: Date.now(),
        agentId,
        subsystem,
        reason,
        inline,
      };
      fallbacks.push(ev);
      return ev;
    }

    // Fire-and-forget: persist the user's message into memory so future
    // retrieval can see it. Fan out to the right scope(s) based on each
    // participating agent's sharing mode:
    //   - shared          → one global write, author_agent_ids = all members
    //   - private         → per-agent private write, author_agent_ids = [that agent]
    //   - readonly-shared → no write
    const ragAgents = data.members
      .map((id) => ({ id, cfg: agentsCfg[id]?.rag }))
      .filter((x) => x.cfg && x.cfg.store === "azure" && x.cfg.chunks);
    const anyShared = ragAgents.some((a) => (a.cfg?.sharing ?? "shared") === "shared");
    const privateAgents = ragAgents
      .filter((a) => a.cfg?.sharing === "private")
      .map((a) => a.id);

    if ((anyShared || privateAgents.length > 0) && openaiKey) {
      (async () => {
        try {
          const { azurePgStore } = await import("./rag/azure-pg.server");
          const { embed } = await import("./rag/embed.server");
          const { extractTriples, shouldExtractTriples } = await import("./rag/triples.server");

          const vec = await embed(data.text);
          const source = `huddle:${data.huddleId}`;

          const writes: Array<{
            chunk: { id: string };
            scope: "global" | "agent";
            agentId?: string;
            authors: string[];
          }> = [];

          if (anyShared) {
            const authors = [...data.members];
            const chunk = await azurePgStore.writeChunk({
              scope: "global",
              text: data.text,
              source,
              embedding: vec,
              authorAgentIds: authors,
            });
            writes.push({ chunk, scope: "global", authors });
          }

          for (const agentId of privateAgents) {
            const authors = [agentId];
            const chunk = await azurePgStore.writeChunk({
              scope: "agent",
              agentId,
              text: data.text,
              source,
              embedding: vec,
              authorAgentIds: authors,
            });
            writes.push({ chunk, scope: "agent", agentId, authors });
          }

          if (writes.length > 0 && shouldExtractTriples(data.text)) {
            const triples = await extractTriples(data.text);
            if (triples.length > 0) {
              for (const w of writes) {
                await azurePgStore.writeTriples(
                  triples.map((t) => ({
                    scope: w.scope,
                    agentId: w.agentId,
                    subject: t.subject,
                    predicate: t.predicate,
                    object: t.object,
                    confidence: t.confidence,
                    sourceChunkId: w.chunk.id,
                    authorAgentIds: w.authors,
                  })),
                );
              }
            }
          }
        } catch (err) {
          // Fire-and-forget path — the client response has already returned,
          // so we can only log here. Failures will still surface on the NEXT
          // turn via the diagnostic panel and the retrieval tool wrapper.
          console.error("[rag] write failed:", err);
        }
      })();
    }

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

    if (data.scope === "group" && !data.targetAgentId && explicitMentions.length === 0 && !canLLMRoute) {
      recordFallback(
        "router",
        `LLM router unavailable (${routerCfg.backend === "openai" ? "OPENAI_API_KEY" : "LOVABLE_API_KEY"} missing); using keyword routing.`,
        "router: keyword fallback (no key)",
      );
    }

    let routed;
    if (canLLMRoute) {
      const invocation: RouterInvocation = {
        backend: routerCfg.backend,
        model: routerCfg.model,
        fastMode: routerCfg.fastMode,
        strictPrompt: routerCfg.strictPrompt,
        soloOnCoverage: routerCfg.soloOnCoverage,
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
      // routeMessageLLM prefixes reason with "LLM fallback:" when it degrades.
      if (routed.decision.reason.startsWith("LLM fallback")) {
        recordFallback(
          "router",
          routed.decision.reason,
          "router: LLM router failed, keyword fallback",
        );
      }
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
      return { decision: routed.decision, replies: [] as Reply[], fallbacks, prompts, journeyTaskUpdates };
    }

    // ---- Reply transcript ----
    // NOTE: `transcript` is rebuilt per-agent below so the *current* agent's
    // prior turns appear as role=assistant (unprefixed) and other agents' turns
    // appear as role=user context — otherwise models mimic the `[Name] ...`
    // prefix pattern in their own replies.

    const presentAgents = AGENTS.filter((a) => data.members.includes(a.id));

    const queue: AgentId[] = [...routed.winners];
    const spoken = new Set<AgentId>();
    const replies: Reply[] = [];

    while (queue.length > 0 && replies.length < MAX_REPLIES_PER_TURN) {
      const nextId = queue.shift()!;
      if (spoken.has(nextId)) continue;
      const winner = AGENT_BY_ID[nextId];
      if (!winner || !data.members.includes(nextId)) continue;

      const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };

      const priorInThisTurn = replies
        .map((r) => `${AGENT_BY_ID[r.agentId].name} just said: "${r.text}"`)
        .join("\n");

      const scene = ` You are ${winner.name} in a ${
        data.scope === "group" ? "group huddle" : "1:1"
      }. Reply naturally, as yourself, in-character — like you're talking in a room with real people. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to". Do not speak as anyone else. 1–3 short sentences unless asked for detail.${
        priorInThisTurn
          ? `\n\nOther agents just replied in this same turn:\n${priorInThisTurn}\nBuild on what they said instead of repeating it. If you have nothing to add, reply with a single short line.`
          : ""
      }`;

      const roster = buildRoster(data.members, winner.id);
      const appSystem =
        winner.systemPrompt +
        scene +
        roster +
        "\n\nWrite as plain prose. Do NOT prefix your reply with your own name, a bracketed label like [Flex Grimes], or a 'Name:' header — the UI already shows who you are.";

      // Per-agent transcript: the current agent's own prior turns are role=assistant
      // (unprefixed); other agents' turns are surfaced as role=user context so the
      // model doesn't imitate a `[Name] ...` prefix pattern.
      const transcript = data.history
        .slice(-14)
        .filter((m) => m.author.kind !== "system")
        .map((m) => {
          if (m.author.kind === "user") return { role: "user" as const, content: m.text };
          const a = AGENT_BY_ID[(m.author as { kind: "agent"; agentId: AgentId }).agentId];
          if (a?.id === winner.id) {
            return { role: "assistant" as const, content: m.text };
          }
          return {
            role: "user" as const,
            content: `(context — ${a?.name ?? "another agent"} said): ${m.text}`,
          };
        })
        .concat([{ role: "user" as const, content: data.text }]);

      const perAgentFallbacks: string[] = [];

      try {
        let clean = "";
        let usedBackend: "openai" | "lovable" = agentBackend.backend;
        let usedModel = "";
        let usedInstructions = "";
        let fromSnapshot = false;
        let toolTypes: string[] = [];

        // Detect config-level fallback before we branch.
        if (agentBackend.backend === "openai" && !openaiKey) {
          const ev = recordFallback(
            "openai",
            `${winner.name} is configured for OpenAI but OPENAI_API_KEY is not set; falling back to Lovable AI.`,
            "openai key missing — using Lovable AI",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
          usedBackend = "lovable";
        }

        if (usedBackend === "openai" && openaiKey) {
          const { callOpenAIResponses } = await import("./openai-responses.server");
          const { getAssistantSnapshot, snapshotResponsesTools } = await import(
            "./openai-assistants.server"
          );

          const snapshot = getAssistantSnapshot(winner.id);
          if (!snapshot) {
            const ev = recordFallback(
              "snapshot",
              `${winner.name}: no OpenAI assistant snapshot on disk; using in-repo persona prompt. Run \`bun run fetch:assistants\` after fixing the assistant ID.`,
              "no assistant snapshot — using in-repo prompt",
              winner.id,
            );
            perAgentFallbacks.push(ev.inline);
          }

          const rag = agentBackend.rag;
          const hasRag =
            !!rag && rag.store === "azure" && (rag.chunks || rag.triples || rag.fileSearch);

          let ragTools: unknown[] = [];
          let onToolCall:
            | ((c: { name: string; arguments: Record<string, unknown> }) => Promise<string>)
            | undefined;
          let ragInstructions = "";

          if (hasRag && rag) {
            try {
              const { buildRagTools, dispatchTool, RAG_SYSTEM_HINT } = await import("./rag/tools");
              const { azurePgStore } = await import("./rag/azure-pg.server");
              const built = buildRagTools({
                chunks: rag.chunks,
                triples: rag.triples,
                fileSearch: rag.fileSearch,
                vectorStoreId: rag.openaiVectorStoreId,
              });
              if (built.length > 0) {
                ragTools = built;
                ragInstructions = "\n\n" + RAG_SYSTEM_HINT;
                const mode = rag.sharing ?? "shared";
                // Wrap dispatchTool so per-call store failures surface as a
                // user-visible fallback instead of silently returning empty.
                onToolCall = async (c) => {
                  try {
                    return await dispatchTool(azurePgStore, winner.id, c, mode);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const ev = recordFallback(
                      "rag",
                      `${winner.name}: memory tool ${c.name} failed — ${msg}`,
                      "memory unavailable — replied without RAG",
                      winner.id,
                    );
                    perAgentFallbacks.push(ev.inline);
                    return JSON.stringify({ error: msg, tool: c.name });
                  }
                };
              }
            } catch (err) {
              const ev = recordFallback(
                "rag",
                `${winner.name}: RAG tools failed to load (${err instanceof Error ? err.message : "unknown"}); replying without memory.`,
                "rag unavailable — replying without memory",
                winner.id,
              );
              perAgentFallbacks.push(ev.inline);
            }
          }

          const snapshotInstructions = snapshot?.instructions?.trim();
          fromSnapshot = !!snapshotInstructions;
          const baseInstructions = snapshotInstructions
            ? snapshotInstructions + scene + roster
            : appSystem;
          const instructions = baseInstructions + ragInstructions;
          usedInstructions = instructions;

          const snapshotTools = snapshotResponsesTools(snapshot);
          // Warn if snapshot had tools we can't wire (e.g. code_interpreter).
          if (snapshot && snapshot.tools.length > snapshotTools.length) {
            const dropped = snapshot.tools
              .map((t) => t?.type)
              .filter((t) => t !== "file_search" && t !== "function") as string[];
            if (dropped.length > 0) {
              const ev = recordFallback(
                "tool",
                `${winner.name}: dropped unsupported assistant tools: ${dropped.join(", ")}.`,
                `dropped tools: ${dropped.join(", ")}`,
                winner.id,
              );
              perAgentFallbacks.push(ev.inline);
            }
          }
          // Journey-voice proxy tools (opt-in per agent).
          let journeyTools: unknown[] = [];
          const journeyNames = new Set<string>();
          if (agentBackend.journey?.enabled) {
            const cached = await ensureJourneyTools();
            if (cached) {
              journeyTools = cached.tools;
              for (const d of cached.defs) journeyNames.add(d.name);
            } else if (journeyToolsError) {
              const ev = recordFallback(
                "tool",
                `${winner.name}: journey-voice proxy tools unavailable — ${journeyToolsError}`,
                "journey tools unavailable",
                winner.id,
              );
              perAgentFallbacks.push(ev.inline);
            }
          }

          const mergedTools = [...snapshotTools, ...ragTools, ...journeyTools];
          toolTypes = mergedTools
            .map((t) => (t as { type?: string })?.type ?? "unknown")
            .filter(Boolean);

          // Wrap onToolCall to route journey-named tools to the proxy while
          // keeping RAG dispatch on the existing handler.
          const ragOnToolCall = onToolCall;
          const combinedOnToolCall = journeyTools.length > 0
            ? async (c: { name: string; arguments: Record<string, unknown> }) => {
                if (journeyNames.has(c.name)) {
                  try {
                    const { invokeJourneyTool } = await import("./journey/proxy.functions");
                    const r = await invokeJourneyTool({
                      toolName: c.name,
                      args: c.arguments,
                      caller: data.caller ?? {},
                      context: {
                        source: "huddle",
                        huddleId: data.huddleId,
                        agentId: winner.id,
                      },
                    });
                    if (r.tasks && r.tasks.length > 0) journeyTaskUpdates.push(...r.tasks);
                    if (!r.ok) {
                      const ev = recordFallback(
                        "tool",
                        `${winner.name}: journey tool ${c.name} failed — ${r.error ?? "unknown"}`,
                        "journey tool failed",
                        winner.id,
                      );
                      perAgentFallbacks.push(ev.inline);
                    }
                    return r.output;
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const ev = recordFallback(
                      "tool",
                      `${winner.name}: journey tool ${c.name} crashed — ${msg}`,
                      "journey tool crashed",
                      winner.id,
                    );
                    perAgentFallbacks.push(ev.inline);
                    return JSON.stringify({ error: msg, tool: c.name });
                  }
                }
                if (ragOnToolCall) return ragOnToolCall(c);
                return JSON.stringify({ error: `Unknown tool: ${c.name}` });
              }
            : ragOnToolCall;

          usedModel = agentBackend.model?.trim() || snapshot?.model || "gpt-4o";

          const text = await callOpenAIResponses({
            model: usedModel,
            instructions,
            transcript: transcript,
            fastMode: routerCfg.fastMode,
            tools: mergedTools.length > 0 ? mergedTools : undefined,
            onToolCall: combinedOnToolCall,
          });
          clean = text.trim();
        } else {
          // Lovable AI path (default fallback).
          usedBackend = "lovable";
          usedModel = "openai/gpt-5.5";
          usedInstructions = appSystem;
          const model = await getLovableModel(usedModel);
          if (!model) {
            const ev = recordFallback(
              "lovable",
              `${winner.name}: LOVABLE_API_KEY is not configured; cannot reach any model.`,
              "no AI backend configured",
              winner.id,
            );
            replies.push({
              agentId: winner.id,
              text: `(fallback: ${ev.inline}) AI gateway is not configured yet.`,
              fallbackNotes: [ev.inline],
            });
            spoken.add(winner.id);
            prompts.push({
              agentId: winner.id,
              backend: "lovable",
              model: usedModel,
              instructions: usedInstructions,
              fromSnapshot: false,
              toolTypes: [],
            });
            continue;
          }
          const { text } = await generateText({
            model,
            system: appSystem,
            messages: transcript,
          });
          clean = text.trim();
        }

        if (!clean) continue;

        // Persist prompt debug for this reply.
        prompts.push({
          agentId: winner.id,
          backend: usedBackend,
          model: usedModel,
          instructions: usedInstructions,
          fromSnapshot,
          toolTypes,
        });

        const finalText = perAgentFallbacks.length > 0
          ? `${clean}\n\n_(fallback: ${perAgentFallbacks.join("; ")})_`
          : clean;

        replies.push({
          agentId: winner.id,
          text: finalText,
          fallbackNotes: perAgentFallbacks.length > 0 ? perAgentFallbacks : undefined,
        });
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
        const ev = recordFallback(
          "openai",
          `${winner.name}: model call failed — ${msg}`,
          `model call failed: ${msg.slice(0, 80)}`,
          winner.id,
        );
        replies.push({
          agentId: winner.id,
          text: `(fallback: ${ev.inline}) couldn't reach the model — ${msg}`,
          fallbackNotes: [ev.inline],
        });
        spoken.add(winner.id);
      }
    }

    return { decision: routed.decision, replies, fallbacks, prompts, journeyTaskUpdates };
  });

