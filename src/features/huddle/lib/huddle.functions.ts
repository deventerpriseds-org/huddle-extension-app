import { createServerFn } from "@tanstack/react-start";
import { generateText, tool, stepCountIs, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage, SuggestedTaskDraft, TaskLane } from "../data/seed";
import { parseMentions, routeMessage, routeMessageLLM, type RouterInvocation } from "./routing";
import type { FallbackEvent, PromptDebug } from "./fallbacks";
import { buildRoster } from "./roster";
import {
  TAVILY_WEB_SEARCH_TOOL,
  TAVILY_WEB_SEARCH_HINT,
  tavilySearch,
  type TavilySearchArgs,
} from "./tavily-search.functions";

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
  interjections: z.boolean().optional(),
  maxInterjectors: z.number().optional(),
});

const AgentBackendInput = z.object({
  backend: z.enum(["lovable", "openai"]),
  assistantId: z.string().optional(),
  model: z.string().optional(),
  instructionsOverride: z.string().optional(),
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
  // The caller's IANA timezone (e.g. "America/New_York") so the grounding block
  // can state the user's LOCAL date, not the server's UTC date. Without it the
  // agent reports the UTC date, which is a day ahead for users behind UTC in the
  // evening.
  timeZone: z.string().max(64).optional(),
});

const MAX_REPLIES_PER_TURN = 4;

// Shared house-style layer — appended to EVERY agent's instructions regardless of
// whether the domain content came from the platform snapshot, a client override,
// or the in-repo persona. Formatting is a Huddle presentation concern that belongs
// in one place, not baked into each agent's prompt; changing it here changes it for
// all agents. (Lane ownership / handoffs are already shared, generated dynamically
// by buildRoster from agents.ts.)
const HOUSE_STYLE =
  "\n\nFormat every reply in the Huddle house style: plain prose in sentence case — no emoji, no markdown headings or bolded section headers, and no long bullet dumps unless the user explicitly asks for a list or a detailed breakdown. Do not prefix your reply with your own name or a bracketed label; the UI already shows who you are. Keep it to 1–3 short sentences unless the user asks for detail." +
  " Never claim an action was actually carried out — sent, emailed, scheduled, booked, created, updated, cancelled, or completed — unless you called a tool THIS turn that performed it and it returned success. If you only drafted, proposed, or planned something, say exactly that; never state it \"has been sent\" or \"is done\" when it has not. Email specifically: text you write in the chat is \"draft text\" — only say you \"saved a draft to your inbox\" if you called the create_email_draft tool and it returned success, and only say an email was \"sent\" if send_email returned success.";

// Deterministic backstop for co-answer echo: a weak router model sometimes
// ignores the "don't repeat what was already said" instruction and re-emits a
// near-verbatim copy of an earlier agent's reply this turn (identical calendar
// readouts, a re-pasted email draft). Prompt wording alone can't guarantee a
// small model complies, so we also detect and drop near-duplicates in code.
// Jaccard over content tokens; >= 0.72 with enough tokens on both sides means
// "said essentially the same thing" — distinct-but-related co-answers score well
// below this, so genuine contributions are never suppressed.
function contentTokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}
function replyJaccard(a: string, b: string): number {
  const A = contentTokenSet(a);
  const B = contentTokenSet(b);
  if (A.size < 4 || B.size < 4) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function isEchoOfPrior(text: string, priorReplies: { text: string }[]): boolean {
  return priorReplies.some((r) => replyJaccard(text, r.text) >= 0.72);
}

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // ---- Grounding: give every agent the current date/time and an explicit
    // freshness rule. The model has no clock and a frozen knowledge cutoff, so
    // without this it confidently guesses dates / "latest version" / prices and
    // is usually wrong. Injecting "now" removes the excuse to guess; the rule
    // tells it to search (when it has web search) or decline to guess (when it
    // doesn't) instead of answering verifiable facts from memory.
    const nowIso = new Date().toISOString();
    // Present the user's LOCAL date/time (server clock is authoritative; the
    // timezone comes from the client). Falls back to UTC-only if absent/invalid.
    let localNow: string | null = null;
    if (data.timeZone) {
      try {
        localNow = new Intl.DateTimeFormat("en-US", {
          timeZone: data.timeZone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(new Date(nowIso));
      } catch {
        localNow = null;
      }
    }
    function groundingBlock(hasWeb: boolean): string {
      const freshness = hasWeb
        ? '- If a request depends on anything time-sensitive or verifiable — "today", "now", "latest", "current", "this week/month/year", a version or release number, a price, a score, standings, recent news, or who currently holds a role — you MUST call the `tavily_web_search` tool and answer ONLY from its results. Never answer these from memory. When unsure whether a fact is still current, search.'
        : "- You do NOT have a web-search tool this turn. For anything time-sensitive or verifiable (dates, prices, versions, standings, recent news), say plainly that you can't verify it right now rather than guessing — do not assert a specific current fact you cannot confirm.";
      return (
        "\n\nKNOWLEDGE AND FRESHNESS\n" +
        "- Your training data has a fixed cutoff. You do NOT inherently know the current date, time, prices, product versions, releases, standings, or news — these change after your cutoff.\n" +
        "- Trust the CONTEXT below over your own assumptions; never compute or guess the current date.\n" +
        freshness +
        "\n- Never state a specific date, version, price, or standing you did not just retrieve from a tool.\n\n" +
        "CONTEXT\n" +
        (localNow
          ? `- Current date and time (the user's local time): ${localNow}\n` +
            `- Same instant in UTC (ISO 8601): ${nowIso}\n` +
            "- When the user asks for \"today\", \"the date\", or the time, use their LOCAL time above, not UTC."
          : `- Current date and time (UTC, ISO 8601): ${nowIso}`)
      );
    }

    type Reply = { agentId: AgentId; text: string; fallbackNotes?: string[] };

    // Journey-voice mirror: any task rows that journey returns from a tool call
    // are accumulated here and returned to the client so the huddle board can
    // upsert them.
    const journeyTaskUpdates: import("./journey/types").JourneyTask[] = [];
    const suggestedTasks: SuggestedTaskDraft[] = [];
    // Reasoning summaries collected across agent turns (reasoning models only).
    const reasoningSummaries: string[] = [];

    // Lazy: fetch & cache journey tool definitions for this whole turn. Only
    // populated when at least one participating agent has journey.enabled.
    let journeyToolsCache: {
      defs: import("./journey/types").JourneyToolDefinition[];
      tools: unknown[];
    } | null = null;
    let journeyToolsError: string | null = null;
    const journeyEnabledMembers = data.members.filter(
      (id) => (data.agents ?? {})[id]?.journey?.enabled,
    );
    async function ensureJourneyTools() {
      if (journeyToolsCache || journeyToolsError) return journeyToolsCache;
      if (journeyEnabledMembers.length === 0) return null;
      try {
        const { fetchJourneyToolDefinitions, toResponsesTool } =
          await import("./journey/proxy.functions");
        // Tools Huddle owns natively (or doesn't want) — don't offer journey's:
        //  - web_search: Huddle uses its own Tavily.
        //  - send_email: Huddle sends via Microsoft Graph (email/graph-email.server).
        const HIDDEN_FROM_HUDDLE = new Set(["web_search", "send_email"]);
        const defs = (await fetchJourneyToolDefinitions()).filter(
          (d) => !HIDDEN_FROM_HUDDLE.has(d.name),
        );
        journeyToolsCache = { defs, tools: defs.map(toResponsesTool) };
        return journeyToolsCache;
      } catch (err) {
        journeyToolsError = err instanceof Error ? err.message : String(err);
        return null;
      }
    }

    const routerCfg = data.router ?? {
      backend: "openai" as const,
      model: "gpt-5.5",
      fastMode: false,
    };
    const agentsCfg = data.agents ?? {};

    // ---- Fallback + prompt trackers ----
    const fallbacks: FallbackEvent[] = [];
    const prompts: PromptDebug[] = [];
    const toolUses: import("../data/seed").ToolUseEvent[] = [];
    let fbSeq = 0;
    let tuSeq = 0;
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
    function recordToolUse(
      agentId: AgentId,
      tool: string,
      summary: string,
      ok: boolean,
      detail?: string,
    ) {
      toolUses.push({
        id: `tu-${Date.now()}-${tuSeq++}`,
        ts: Date.now(),
        agentId,
        tool,
        summary,
        ok,
        detail,
      });
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
    const privateAgents = ragAgents.filter((a) => a.cfg?.sharing === "private").map((a) => a.id);

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

    if (
      data.scope === "group" &&
      !data.targetAgentId &&
      explicitMentions.length === 0 &&
      !canLLMRoute
    ) {
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
        interjections: routerCfg.interjections,
        journeyEnabledIds: journeyEnabledMembers,
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
      return {
        decision: routed.decision,
        replies: [] as Reply[],
        fallbacks,
        prompts,
        journeyTaskUpdates,
        suggestedTasks,
        toolUses,
        reasoning: reasoningSummaries,
      };
    }

    // ---- Reply transcript ----
    // NOTE: `transcript` is rebuilt per-agent below so the *current* agent's
    // prior turns appear as role=assistant (unprefixed) and other agents' turns
    // appear as role=user context — otherwise models mimic the `[Name] ...`
    // prefix pattern in their own replies.

    const presentAgents = AGENTS.filter((a) => data.members.includes(a.id));

    // Interjectors: agents the router flagged as holding specific substantive
    // value beyond the primary's answer. Appended AFTER the primary winners so
    // they see the primary's reply; each self-censors ("PASS") if it turns out
    // to have nothing concrete. Gated by the router's interjections toggle.
    const interjectorSet = new Set<AgentId>();
    if (routerCfg.interjections && (routerCfg.maxInterjectors ?? 2) > 0) {
      for (const id of (routed.interjectors ?? []).slice(0, routerCfg.maxInterjectors ?? 2)) {
        if (data.members.includes(id) && !routed.winners.includes(id)) interjectorSet.add(id);
      }
    }

    const queue: AgentId[] = [...routed.winners, ...interjectorSet];
    const spoken = new Set<AgentId>();
    const replies: Reply[] = [];

    // A broadcast ("everyone introduce yourselves") means every member should
    // get to speak, so lift the normal per-turn reply cap for that case.
    const { isBroadcast } = await import("./routing");
    const broadcastTurn = data.scope === "group" && isBroadcast(data.text);
    const replyCap = broadcastTurn
      ? Math.min(data.members.length, 12)
      : MAX_REPLIES_PER_TURN + interjectorSet.size;

    while (queue.length > 0 && replies.length < replyCap) {
      const nextId = queue.shift()!;
      if (spoken.has(nextId)) continue;
      const winner = AGENT_BY_ID[nextId];
      if (!winner || !data.members.includes(nextId)) continue;

      const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };

      const priorInThisTurn = replies
        .map((r) => `${AGENT_BY_ID[r.agentId].name} just said: "${r.text}"`)
        .join("\n");

      const isInterjector = interjectorSet.has(nextId);
      const interjectDirective = isInterjector
        ? `\n\nYou were NOT asked directly — you are interjecting ONLY to surface specific information the primary cannot see. Do NOT repeat, restate, agree with, or react to what the primary said. FIRST use your own tools to look up the user's actual schedule / tasks / contacts for the relevant time, person, or deadline. Then:
- If your tools return something concrete and relevant (a conflict, a prep note, a risk), reply with ONLY that, one short sentence, leading with the value — e.g. "Heads up — you already have a 12pm investor call."
- If your tools return nothing relevant, reply with exactly the single word: PASS (nothing before or after it).`
        : "";

      const scene = ` You are ${winner.name} in a ${
        data.scope === "group" ? "group huddle" : "1:1"
      }. Reply naturally, as yourself, in-character — like you're talking in a room with real people. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to". Do not speak as anyone else. 1–3 short sentences unless asked for detail.${
        priorInThisTurn
          ? `\n\nOther agents ALREADY replied in this same turn:\n${priorInThisTurn}\nDo NOT restate, re-answer, paraphrase, or agree with what they said — the user already read it. Contribute ONLY the distinct piece your own lane owns that they did not cover. If you have nothing to add beyond what's been said, reply with a single short sentence deferring to them (e.g. "nothing to add — @finn-reid covered it"). Never repeat another agent's answer back.`
          : ""
      }${interjectDirective}`;

      const roster = buildRoster(data.members, winner.id);
      const taskToolInstructions =
        "\n\nYou have a `create_huddle_task` tool. When the user asks to add, create, log, track, assign, capture, or put a task/action item on the board, call `create_huddle_task` before answering. It creates a suggested board card for user approval; do not merely say you will add it.";
      const appSystem =
        winner.systemPrompt +
        scene +
        roster +
        taskToolInstructions +
        HOUSE_STYLE;

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
      const timeSensitiveRe =
        /\b(today|tonight|tomorrow|yesterday|this week|this month|this year|latest|current|currently|right now|recent|recently|news|breaking|headline|score|price|stock|weather|forecast|202\d|updated|update)\b/i;
      const createTaskRe =
        /\b(add|create|make|log|track|put|place|capture|assign|remind me|todo|to-do|action item|follow[- ]?up)\b/i;
      const forceTaskCreation = createTaskRe.test(data.text);
      const forceWebSearch = !!agentBackend.webSearch && timeSensitiveRe.test(data.text);

      function resolveTaskLane(value: unknown): TaskLane {
        const lane = String(value ?? "")
          .trim()
          .toLowerCase();
        if (lane === "blocked") return "Blocked";
        if (lane === "ready") return "Ready";
        if (lane === "up next" || lane === "up-next" || lane === "next") return "Up next";
        if (lane === "doing" || lane === "in progress") return "Doing";
        if (lane === "done" || lane === "complete" || lane === "completed") return "Done";
        return "Backlog";
      }

      function resolveTaskOwner(value: unknown): AgentId {
        const raw = String(value ?? "")
          .trim()
          .toLowerCase();
        if (!raw) return winner.id;
        if (AGENT_BY_ID[raw as AgentId]) return raw as AgentId;
        const matched = AGENTS.find(
          (a) =>
            a.name.toLowerCase() === raw ||
            a.handle.toLowerCase() === raw ||
            a.name.toLowerCase().includes(raw) ||
            raw.includes(a.handle.toLowerCase()),
        );
        return matched?.id ?? winner.id;
      }

      async function createSuggestedTaskFromTool(args: Record<string, unknown>) {
        const title = String(args.title ?? args.task ?? args.name ?? "").trim();
        if (!title) {
          const error = "create_huddle_task requires a title";
          recordToolUse(winner.id, "create_huddle_task", "task creation failed", false, error);
          return { ok: false, error };
        }
        const task: SuggestedTaskDraft = {
          id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          title: title.slice(0, 160),
          ownerId: resolveTaskOwner(args.ownerId ?? args.owner ?? args.assignee),
          lane: resolveTaskLane(args.lane ?? args.status),
          progress: typeof args.progress === "number" ? args.progress : undefined,
          blockReason: typeof args.blockReason === "string" ? args.blockReason : undefined,
        };

        // Dual-write: a task created from Huddle should land on BOTH the Huddle
        // board and the journey board. When this agent has journey enabled and we
        // know the caller, also create it in journey. On success the journey task
        // is mirrored onto the Huddle board (journeyTaskUpdates) so exactly one
        // card shows; if journey is off or fails, fall back to a Huddle-only card.
        if (agentBackend.journey?.enabled && data.caller?.entra_email) {
          try {
            const { invokeJourneyTool } = await import("./journey/proxy.functions");
            const r = await invokeJourneyTool({
              toolName: "quick_create_task",
              args: { title: task.title },
              caller: data.caller ?? {},
              context: { source: "huddle", huddleId: data.huddleId, agentId: winner.id },
            });
            if (r.ok) {
              if (r.tasks && r.tasks.length > 0) journeyTaskUpdates.push(...r.tasks);
              else suggestedTasks.push(task); // journey didn't echo a row — keep a Huddle card
              recordToolUse(
                winner.id,
                "create_huddle_task",
                `“${task.title}” → Huddle board + journey`,
                true,
              );
              return { ok: true, task, boards: ["huddle", "journey"] };
            }
            const ev = recordFallback(
              "tool",
              `${winner.name}: task saved to the Huddle board but journey create failed — ${r.error ?? "unknown"}`,
              "journey task create failed",
              winner.id,
            );
            perAgentFallbacks.push(ev.inline);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const ev = recordFallback(
              "tool",
              `${winner.name}: task saved to the Huddle board but journey create crashed — ${msg}`,
              "journey task create crashed",
              winner.id,
            );
            perAgentFallbacks.push(ev.inline);
          }
        }

        // Huddle-only path (journey disabled, no caller, or journey create failed).
        suggestedTasks.push(task);
        recordToolUse(
          winner.id,
          "create_huddle_task",
          `suggested “${task.title}” · owner ${AGENT_BY_ID[task.ownerId].name}`,
          true,
        );
        return { ok: true, task, boards: ["huddle"] };
      }

      try {
        let clean = "";
        let usedBackend: "openai" | "lovable" = agentBackend.backend;
        let usedModel = "";
        let usedInstructions = "";
        let fromSnapshot = false;
        let toolTypes: string[] = [];

        // Route to whichever backend is actually configured. Agents default to
        // the Lovable gateway until they get their own OpenAI assistant, but that
        // gateway only exists inside Lovable — once deployed elsewhere there's no
        // LOVABLE_API_KEY. So if an agent's chosen backend has no key but the
        // other one does, run it there instead of dead-failing. OpenAI can run
        // any agent from its in-repo persona prompt (no assistant required).
        if (agentBackend.backend === "openai" && !openaiKey && lovableKey) {
          const ev = recordFallback(
            "openai",
            `${winner.name} is configured for OpenAI but OPENAI_API_KEY is not set; falling back to Lovable AI.`,
            "openai key missing — using Lovable AI",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
          usedBackend = "lovable";
        } else if (agentBackend.backend === "lovable" && !lovableKey && openaiKey) {
          // The common case after moving off Lovable: no gateway key, but OpenAI
          // is configured. Run the agent on OpenAI with its persona prompt.
          usedBackend = "openai";
        }

        if (usedBackend === "openai" && openaiKey) {
          const { callOpenAIResponses } = await import("./openai-responses.server");
          const { getAssistantSnapshot, snapshotResponsesTools } =
            await import("./openai-assistants.server");

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

          // Instruction source, most-authoritative first: a client-applied
          // override (from "Check platform for updates" or a manual edit) wins
          // over the bundled snapshot, which wins over the in-repo persona.
          const overrideInstructions = agentBackend.instructionsOverride?.trim();
          const snapshotInstructions = snapshot?.instructions?.trim();
          const effectiveInstructions = overrideInstructions || snapshotInstructions;
          fromSnapshot = !overrideInstructions && !!snapshotInstructions;
          const baseInstructions = effectiveInstructions
            ? effectiveInstructions + scene + roster + taskToolInstructions + HOUSE_STYLE
            : appSystem;
          const webInstructions = agentBackend.webSearch ? "\n\n" + TAVILY_WEB_SEARCH_HINT : "";
          const { PRIORITIZE_SYSTEM_HINT } = await import("./tasks/tools");
          const instructions =
            baseInstructions +
            ragInstructions +
            webInstructions +
            "\n\n" + PRIORITIZE_SYSTEM_HINT +
            groundingBlock(!!agentBackend.webSearch);
          usedInstructions = instructions;

          // The assistant snapshot carries the original journey-voice assistant's
          // function tools (e.g. "Email", "get_tasks"). Huddle has no executor for
          // snapshot function tools — worse, they shadow the wired journey proxy
          // tools (the model picks the snapshot's "Email" over journey's
          // "send_email" and hits a dead end). Offer only non-function snapshot
          // tools (file_search); the real functions come from the journey catalog.
          const snapshotTools = snapshotResponsesTools(snapshot).filter(
            (t) => (t as { type?: string })?.type !== "function",
          );
          const snapshotToolNames = new Set(
            snapshotTools
              .map((t) => (t as { name?: string })?.name)
              .filter((name): name is string => !!name),
          );
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

          // Tavily web search tool (opt-in per agent).
          const webSearchTools: unknown[] = agentBackend.webSearch ? [TAVILY_WEB_SEARCH_TOOL] : [];

          const createHuddleTaskTool = {
            type: "function" as const,
            name: "create_huddle_task",
            description:
              "Create a task when the user asks to add, log, track, assign, or capture a task/action item. It is added to the Huddle board and, when the user's journey account is connected, also created on their journey board — one call covers both.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", description: "Short task title." },
                ownerId: {
                  type: "string",
                  description:
                    "Optional owner agent id, handle, or name. Defaults to the current agent.",
                },
                lane: {
                  type: "string",
                  description:
                    "Optional board lane: Backlog, Ready, Up next, Doing, Done, or Blocked. Defaults to Backlog.",
                },
                blockReason: { type: "string", description: "Optional blocker note." },
              },
              required: ["title"],
            },
            strict: false,
          };

          // Native Huddle email (Microsoft Graph). Offered when the Graph app
          // creds are configured; sends as an allow-listed tenant mailbox.
          const { emailFromOptions, graphEmailConfigured } = await import(
            "./email/graph-email.server"
          );
          const emailTools: unknown[] = [];
          if (graphEmailConfigured()) {
            const fromOpts = emailFromOptions();
            emailTools.push({
              type: "function" as const,
              name: "send_email",
              description:
                `Send an email via Microsoft (Outlook/Office 365). Sends from ${fromOpts[0]} by default; ` +
                `set "from" to one of: ${fromOpts.join(", ")} to send from a different mailbox. ` +
                `Requires a recipient (to), a subject, and a body. Use this whenever the user asks to email someone.`,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  to: {
                    type: "string",
                    description: "Recipient email address. Comma-separate multiple recipients.",
                  },
                  subject: { type: "string", description: "Email subject line." },
                  body: { type: "string", description: "Email body (plain text)." },
                  from: {
                    type: "string",
                    description: `Optional sender mailbox. Defaults to ${fromOpts[0]}. Allowed: ${fromOpts.join(", ")}.`,
                  },
                  cc: { type: "string", description: "Optional CC address(es), comma-separated." },
                },
                required: ["to", "subject", "body"],
              },
              strict: false,
            });
            emailTools.push({
              type: "function" as const,
              name: "create_email_draft",
              description:
                `Save a REAL draft email to the ${fromOpts[0]} mailbox's Drafts folder (does NOT send it). ` +
                `Use this when the user asks you to draft, prepare, or write up an email for later — it creates an actual draft they can open, edit and send, and returns the draft's link. ` +
                `A subject and body are required; recipients (to) are optional for a draft.`,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  subject: { type: "string", description: "Email subject line." },
                  body: { type: "string", description: "Email body (plain text)." },
                  to: {
                    type: "string",
                    description: "Optional recipient address(es), comma-separated.",
                  },
                  from: {
                    type: "string",
                    description: `Optional mailbox to draft in. Defaults to ${fromOpts[0]}. Allowed: ${fromOpts.join(", ")}.`,
                  },
                  cc: { type: "string", description: "Optional CC address(es), comma-separated." },
                },
                required: ["subject", "body"],
              },
              strict: false,
            });
          }

          const { PRIORITIZE_TOOL } = await import("./tasks/tools");
          const mergedTools = [
            createHuddleTaskTool,
            PRIORITIZE_TOOL,
            ...emailTools,
            ...snapshotTools,
            ...ragTools,
            ...journeyTools,
            ...webSearchTools,
          ];
          toolTypes = mergedTools
            .map((t) => {
              const rec = t as { type?: string; name?: string };
              if (rec.name) return rec.name;
              if (rec.type === "file_search") return "file_search";
              return rec.type ?? "unknown";
            })
            .filter(Boolean);

          if (toolTypes.length > 0) {
            recordToolUse(winner.id, "tool_catalog", `offered: ${toolTypes.join(", ")}`, true);
          }

          // Wrap onToolCall to route Tavily web search and journey tools, while
          // keeping RAG dispatch on the existing handler.
          const ragOnToolCall = onToolCall;
          const combinedOnToolCall = async (c: {
            name: string;
            arguments: Record<string, unknown>;
          }) => {
            if (c.name === "create_huddle_task") {
              return JSON.stringify(await createSuggestedTaskFromTool(c.arguments));
            }
            if (c.name === "prioritize") {
              const { dispatchPrioritize } = await import("./tasks/tools");
              return dispatchPrioritize(data.caller?.entra_email, c.arguments);
            }
            if (c.name === "send_email") {
              const a = c.arguments as Record<string, unknown>;
              try {
                const { sendGraphEmail } = await import("./email/graph-email.server");
                const r = await sendGraphEmail({
                  to: String(a.to ?? ""),
                  subject: String(a.subject ?? ""),
                  body: String(a.body ?? ""),
                  from: a.from ? String(a.from) : undefined,
                  cc: a.cc ? String(a.cc) : undefined,
                });
                recordToolUse(
                  winner.id,
                  "send_email",
                  r.ok ? `sent from ${r.from} → ${(r.to ?? []).join(", ")}` : `send failed`,
                  r.ok,
                  r.ok ? undefined : r.error,
                );
                if (!r.ok) {
                  const ev = recordFallback(
                    "tool",
                    `${winner.name}: send_email failed — ${r.error ?? "unknown"}`,
                    "send_email failed",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                }
                return JSON.stringify(r);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "send_email", "send crashed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            }
            if (c.name === "create_email_draft") {
              const a = c.arguments as Record<string, unknown>;
              try {
                const { createGraphDraft } = await import("./email/graph-email.server");
                const r = await createGraphDraft({
                  to: String(a.to ?? ""),
                  subject: String(a.subject ?? ""),
                  body: String(a.body ?? ""),
                  from: a.from ? String(a.from) : undefined,
                  cc: a.cc ? String(a.cc) : undefined,
                });
                recordToolUse(
                  winner.id,
                  "create_email_draft",
                  r.ok ? `draft saved in ${r.from} (id ${String(r.id ?? "").slice(0, 12)}…)` : "draft failed",
                  r.ok,
                  r.ok ? undefined : r.error,
                );
                if (!r.ok) {
                  const ev = recordFallback(
                    "tool",
                    `${winner.name}: create_email_draft failed — ${r.error ?? "unknown"}`,
                    "create_email_draft failed",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                }
                return JSON.stringify(r);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "create_email_draft", "draft crashed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            }
            if (c.name === "tavily_web_search") {
              const q = String(c.arguments.query ?? "").trim() || "unknown";
              try {
                const r = await tavilySearch({
                  query: q,
                  topic: c.arguments.topic as TavilySearchArgs["topic"],
                  search_depth: c.arguments.search_depth as TavilySearchArgs["search_depth"],
                  time_range: c.arguments.time_range as TavilySearchArgs["time_range"],
                  start_date: c.arguments.start_date as string | undefined,
                  end_date: c.arguments.end_date as string | undefined,
                  include_domains: c.arguments.include_domains as string[] | undefined,
                  exclude_domains: c.arguments.exclude_domains as string[] | undefined,
                  max_results: c.arguments.max_results as number | undefined,
                });
                const resultCount = Array.isArray((r as { results?: unknown[] }).results)
                  ? (r as { results: unknown[] }).results.length
                  : 0;
                recordToolUse(
                  winner.id,
                  "tavily_web_search",
                  r.success
                    ? `“${q}” · ${resultCount} result${resultCount === 1 ? "" : "s"}`
                    : `“${q}” · failed`,
                  !!r.success,
                  r.success ? undefined : r.error,
                );
                if (!r.success) {
                  const ev = recordFallback(
                    "tool",
                    `${winner.name}: web search failed — ${r.error ?? "unknown"}`,
                    "web search unavailable",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                }
                return JSON.stringify(r);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "tavily_web_search", `“${q}” · crashed`, false, msg);
                const ev = recordFallback(
                  "tool",
                  `${winner.name}: web search crashed — ${msg}`,
                  "web search crashed",
                  winner.id,
                );
                perAgentFallbacks.push(ev.inline);
                return JSON.stringify({ error: msg, tool: c.name });
              }
            }
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
                recordToolUse(
                  winner.id,
                  c.name,
                  r.ok ? `journey-voice · ok` : `journey-voice · failed`,
                  !!r.ok,
                  r.ok ? undefined : r.error,
                );
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
                recordToolUse(winner.id, c.name, `journey-voice · crashed`, false, msg);
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
            if (snapshotToolNames.has(c.name)) {
              const detail =
                "This assistant snapshot exposes the tool schema, but Huddle does not have a local executor or journey proxy handler for it.";
              recordToolUse(
                winner.id,
                c.name,
                "snapshot tool offered but not executable",
                false,
                detail,
              );
              const ev = recordFallback(
                "tool",
                `${winner.name}: snapshot tool ${c.name} was requested but no executor is wired in Huddle.`,
                "snapshot tool has no executor",
                winner.id,
              );
              perAgentFallbacks.push(ev.inline);
              return JSON.stringify({ error: detail, tool: c.name });
            }
            if (ragOnToolCall) {
              const out = await ragOnToolCall(c);
              let ok = true;
              try {
                const parsed = JSON.parse(out);
                if (parsed && typeof parsed === "object" && "error" in parsed) ok = false;
              } catch {
                /* non-JSON is fine */
              }
              recordToolUse(winner.id, c.name, ok ? "memory query" : "memory query · failed", ok);
              return out;
            }
            return JSON.stringify({ error: `Unknown tool: ${c.name}` });
          };

          usedModel = agentBackend.model?.trim() || snapshot?.model || "gpt-4o";

          const toolChoice = forceTaskCreation
            ? { type: "function", name: "create_huddle_task" }
            : forceWebSearch
              ? { type: "function", name: "tavily_web_search" }
              : undefined;

          if (forceTaskCreation) {
            recordToolUse(winner.id, "create_huddle_task", "offered (forced — task request)", true);
          } else if (forceWebSearch) {
            recordToolUse(
              winner.id,
              "tavily_web_search",
              "offered (forced — time-sensitive)",
              true,
            );
          }

          const persona = await callOpenAIResponses({
            model: usedModel,
            instructions,
            transcript: transcript,
            fastMode: routerCfg.fastMode,
            tools: mergedTools.length > 0 ? mergedTools : undefined,
            onToolCall: combinedOnToolCall,
            toolChoice,
            maxToolHops: 5,
          });
          clean = persona.text.trim();
          if (persona.reasoning.length > 0) {
            reasoningSummaries.push(
              ...persona.reasoning.map((r) => `${winner.name}: ${r}`),
            );
          }
        } else {
          // Lovable AI path (default backend). Wire the SAME native tools the
          // OpenAI path offers — create_huddle_task, Tavily, RAG memory, and the
          // journey-voice proxy — so default-backend agents are not silently
          // missing capabilities. Anything that cannot run on this path (e.g.
          // file_search) is surfaced as a fallback, never dropped silently.
          usedBackend = "lovable";
          usedModel = "openai/gpt-5.5";
          const webInstructions = agentBackend.webSearch ? "\n\n" + TAVILY_WEB_SEARCH_HINT : "";
          usedInstructions = appSystem + webInstructions;
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

          const rag = agentBackend.rag;
          const hasRagChunks = !!rag && rag.store === "azure" && rag.chunks;
          const hasRagTriples = !!rag && rag.store === "azure" && rag.triples;
          const wantsFileSearch = !!rag && rag.store === "azure" && rag.fileSearch;
          const ragMode = rag?.sharing ?? "shared";
          let ragInstructions = "";

          // file_search is an OpenAI-Responses-only capability and cannot run on
          // the Lovable gateway — surface it instead of dropping it silently.
          if (wantsFileSearch) {
            const ev = recordFallback(
              "rag",
              `${winner.name}: file_search is only available on the OpenAI backend; skipped on the Lovable gateway.`,
              "file_search unavailable on Lovable backend",
              winner.id,
            );
            perAgentFallbacks.push(ev.inline);
          }

          const lovableTools: ToolSet = {};

          // create_huddle_task — always available (mirrors the OpenAI path).
          lovableTools.create_huddle_task = tool({
            description:
              "Create a task when the user asks to add, log, track, assign, or capture a task/action item. It is added to the Huddle board and, when the user's journey account is connected, also created on their journey board — one call covers both.",
            inputSchema: z.object({
              title: z.string(),
              ownerId: z.string().optional(),
              lane: z.string().optional(),
              blockReason: z.string().optional(),
            }),
            execute: async (args) =>
              JSON.stringify(await createSuggestedTaskFromTool(args as Record<string, unknown>)),
          });

          // prioritize — shared prioritization tool (mirrors the OpenAI path).
          {
            const { dispatchPrioritize } = await import("./tasks/tools");
            lovableTools.prioritize = tool({
              description:
                "Rank the user's open tasks by what to do next (priority, due dates, staleness), optionally within a category (LIFE, VENTURES, CAREER, EDUCATION, PERSONAL, PROF_EDUCATION). Call it when the user asks what to focus on / prioritize / do next.",
              inputSchema: z.object({
                category: z.string().optional(),
                limit: z.number().optional(),
              }),
              execute: async (args) =>
                dispatchPrioritize(data.caller?.entra_email, args as Record<string, unknown>),
            });
          }

          // Native Huddle email via Microsoft Graph (mirrors the OpenAI path).
          {
            const { emailFromOptions, graphEmailConfigured } = await import(
              "./email/graph-email.server"
            );
            if (graphEmailConfigured()) {
              const fromOpts = emailFromOptions();
              lovableTools.send_email = tool({
                description:
                  `Send an email via Microsoft (Outlook/Office 365). Sends from ${fromOpts[0]} by default; ` +
                  `set "from" to one of: ${fromOpts.join(", ")} to send from a different mailbox. ` +
                  `Requires to, subject, and body. Use whenever the user asks to email someone.`,
                inputSchema: z.object({
                  to: z.string(),
                  subject: z.string(),
                  body: z.string(),
                  from: z.string().optional(),
                  cc: z.string().optional(),
                }),
                execute: async (args) => {
                  const a = args as Record<string, unknown>;
                  const { sendGraphEmail } = await import("./email/graph-email.server");
                  const r = await sendGraphEmail({
                    to: String(a.to ?? ""),
                    subject: String(a.subject ?? ""),
                    body: String(a.body ?? ""),
                    from: a.from ? String(a.from) : undefined,
                    cc: a.cc ? String(a.cc) : undefined,
                  });
                  recordToolUse(
                    winner.id,
                    "send_email",
                    r.ok ? `sent from ${r.from} → ${(r.to ?? []).join(", ")}` : "send failed",
                    r.ok,
                    r.ok ? undefined : r.error,
                  );
                  return JSON.stringify(r);
                },
              });
              lovableTools.create_email_draft = tool({
                description:
                  `Save a REAL draft email to the ${fromOpts[0]} mailbox's Drafts folder (does NOT send it). ` +
                  `Use when the user asks to draft/prepare an email for later; returns the draft's link. ` +
                  `Subject and body required; recipients optional.`,
                inputSchema: z.object({
                  subject: z.string(),
                  body: z.string(),
                  to: z.string().optional(),
                  from: z.string().optional(),
                  cc: z.string().optional(),
                }),
                execute: async (args) => {
                  const a = args as Record<string, unknown>;
                  const { createGraphDraft } = await import("./email/graph-email.server");
                  const r = await createGraphDraft({
                    to: String(a.to ?? ""),
                    subject: String(a.subject ?? ""),
                    body: String(a.body ?? ""),
                    from: a.from ? String(a.from) : undefined,
                    cc: a.cc ? String(a.cc) : undefined,
                  });
                  recordToolUse(
                    winner.id,
                    "create_email_draft",
                    r.ok ? `draft saved in ${r.from}` : "draft failed",
                    r.ok,
                    r.ok ? undefined : r.error,
                  );
                  return JSON.stringify(r);
                },
              });
            }
          }

          if (agentBackend.webSearch) {
            lovableTools.tavily_web_search = tool({
              description:
                "Search the live web via Tavily. Use for current events, news, dates, prices, or anything after your training cutoff.",
              inputSchema: z.object({
                query: z.string(),
                topic: z.enum(["general", "news", "finance"]).optional(),
                search_depth: z.enum(["basic", "advanced"]).optional(),
                time_range: z.enum(["day", "week", "month", "year"]).optional(),
                max_results: z.number().optional(),
              }),
              execute: async (args) => {
                const q = String(args.query ?? "").trim() || "unknown";
                try {
                  const r = await tavilySearch({
                    query: q,
                    topic: args.topic as TavilySearchArgs["topic"],
                    search_depth: args.search_depth as TavilySearchArgs["search_depth"],
                    time_range: args.time_range as TavilySearchArgs["time_range"],
                    max_results: args.max_results,
                  });
                  const resultCount = Array.isArray((r as { results?: unknown[] }).results)
                    ? (r as { results: unknown[] }).results.length
                    : 0;
                  recordToolUse(
                    winner.id,
                    "tavily_web_search",
                    r.success
                      ? `“${q}” · ${resultCount} result${resultCount === 1 ? "" : "s"}`
                      : `“${q}” · failed`,
                    r.success,
                  );
                  if (!r.success) {
                    const ev = recordFallback(
                      "tool",
                      `${winner.name}: web search failed — ${r.error ?? "unknown"}`,
                      "web search unavailable",
                      winner.id,
                    );
                    perAgentFallbacks.push(ev.inline);
                  }
                  return r;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  recordToolUse(winner.id, "tavily_web_search", `“${q}” · crashed`, false, msg);
                  const ev = recordFallback(
                    "tool",
                    `${winner.name}: web search crashed — ${msg}`,
                    "web search crashed",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                  return { success: false, error: msg };
                }
              },
            });
          }

          // RAG memory tools (Azure pgvector) — same executors as the OpenAI path.
          if (hasRagChunks || hasRagTriples) {
            try {
              const { dispatchTool, RAG_SYSTEM_HINT, SEARCH_MEMORY_TOOL, LOOKUP_FACTS_TOOL } =
                await import("./rag/tools");
              const { azurePgStore } = await import("./rag/azure-pg.server");
              ragInstructions = "\n\n" + RAG_SYSTEM_HINT;
              const runRag = async (name: string, args: Record<string, unknown>) => {
                try {
                  const out = await dispatchTool(
                    azurePgStore,
                    winner.id,
                    { name, arguments: args },
                    ragMode,
                  );
                  let ok = true;
                  try {
                    const parsed = JSON.parse(out);
                    if (parsed && typeof parsed === "object" && "error" in parsed) ok = false;
                  } catch {
                    /* non-JSON is fine */
                  }
                  recordToolUse(winner.id, name, ok ? "memory query" : "memory query · failed", ok);
                  return out;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  recordToolUse(winner.id, name, "memory query · failed", false, msg);
                  const ev = recordFallback(
                    "rag",
                    `${winner.name}: memory tool ${name} failed — ${msg}`,
                    "memory unavailable — replied without RAG",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                  return JSON.stringify({ error: msg, tool: name });
                }
              };
              if (hasRagChunks) {
                lovableTools.search_memory = tool({
                  description: SEARCH_MEMORY_TOOL.description,
                  inputSchema: z.object({ query: z.string(), k: z.number().optional() }),
                  execute: async (args) => runRag("search_memory", args as Record<string, unknown>),
                });
              }
              if (hasRagTriples) {
                lovableTools.lookup_facts = tool({
                  description: LOOKUP_FACTS_TOOL.description,
                  inputSchema: z.object({
                    subject: z.string().optional(),
                    predicate: z.string().optional(),
                    query: z.string().optional(),
                    k: z.number().optional(),
                  }),
                  execute: async (args) => runRag("lookup_facts", args as Record<string, unknown>),
                });
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

          // Journey-voice proxy tools (opt-in per agent).
          if (agentBackend.journey?.enabled) {
            const cached = await ensureJourneyTools();
            if (cached) {
              for (const def of cached.defs) {
                lovableTools[def.name] = tool({
                  description: def.description,
                  inputSchema: jsonSchema(
                    def.parameters as unknown as Parameters<typeof jsonSchema>[0],
                  ),
                  execute: async (args) => {
                    try {
                      const { invokeJourneyTool } = await import("./journey/proxy.functions");
                      const r = await invokeJourneyTool({
                        toolName: def.name,
                        args: (args ?? {}) as Record<string, unknown>,
                        caller: data.caller ?? {},
                        context: {
                          source: "huddle",
                          huddleId: data.huddleId,
                          agentId: winner.id,
                        },
                      });
                      if (r.tasks && r.tasks.length > 0) journeyTaskUpdates.push(...r.tasks);
                      recordToolUse(
                        winner.id,
                        def.name,
                        r.ok ? `journey-voice · ok` : `journey-voice · failed`,
                        !!r.ok,
                        r.ok ? undefined : r.error,
                      );
                      if (!r.ok) {
                        const ev = recordFallback(
                          "tool",
                          `${winner.name}: journey tool ${def.name} failed — ${r.error ?? "unknown"}`,
                          "journey tool failed",
                          winner.id,
                        );
                        perAgentFallbacks.push(ev.inline);
                      }
                      return r.output;
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      recordToolUse(winner.id, def.name, `journey-voice · crashed`, false, msg);
                      const ev = recordFallback(
                        "tool",
                        `${winner.name}: journey tool ${def.name} crashed — ${msg}`,
                        "journey tool crashed",
                        winner.id,
                      );
                      perAgentFallbacks.push(ev.inline);
                      return JSON.stringify({ error: msg, tool: def.name });
                    }
                  },
                });
              }
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

          {
            const { PRIORITIZE_SYSTEM_HINT } = await import("./tasks/tools");
            usedInstructions =
              appSystem +
              ragInstructions +
              webInstructions +
              "\n\n" + PRIORITIZE_SYSTEM_HINT +
              groundingBlock(!!agentBackend.webSearch);
          }

          const toolNames = Object.keys(lovableTools);
          toolTypes = toolNames;
          if (toolNames.length > 0) {
            recordToolUse(winner.id, "tool_catalog", `offered: ${toolNames.join(", ")}`, true);
          }

          const lovableToolChoice =
            forceTaskCreation && lovableTools.create_huddle_task
              ? { type: "tool" as const, toolName: "create_huddle_task" }
              : forceWebSearch && lovableTools.tavily_web_search
                ? { type: "tool" as const, toolName: "tavily_web_search" }
                : undefined;

          if (forceTaskCreation && lovableTools.create_huddle_task) {
            recordToolUse(winner.id, "create_huddle_task", "offered (forced — task request)", true);
          } else if (forceWebSearch && lovableTools.tavily_web_search) {
            recordToolUse(
              winner.id,
              "tavily_web_search",
              "offered (forced — time-sensitive)",
              true,
            );
          }

          const { text } = await generateText({
            model,
            system: usedInstructions,
            messages: transcript,
            tools: toolNames.length > 0 ? lovableTools : undefined,
            // Force the chosen tool on the FIRST step only, then release to
            // "auto". A forced toolChoice persists across every step otherwise,
            // which would re-invoke the same tool until the step cap is hit.
            toolChoice: lovableToolChoice,
            prepareStep: lovableToolChoice
              ? ({ stepNumber }) =>
                  stepNumber === 0 ? { toolChoice: lovableToolChoice } : { toolChoice: "auto" }
              : undefined,
            stopWhen: stepCountIs(50),
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

        // An interjector that found nothing concrete stays silent. Catch a bare
        // "PASS" as well as the model appending PASS after echoing the primary.
        const interjTrimmed = clean.trim();
        if (
          isInterjector &&
          (/^pass[.!]?$/i.test(interjTrimmed) || /\bPASS[.!]?$/.test(interjTrimmed))
        ) {
          spoken.add(winner.id);
          continue;
        }

        // Deterministic echo guard: if this reply is a near-duplicate of one an
        // earlier agent already gave this turn, drop it (the point was already
        // made). Backstops the "don't repeat what was said" instruction, which a
        // weak model obeys inconsistently. Never fires on the first speaker.
        if (interjTrimmed && isEchoOfPrior(interjTrimmed, replies)) {
          recordFallback(
            "tool",
            `${winner.name}: near-duplicate of an earlier reply this turn — suppressed to avoid echo.`,
            "duplicate reply suppressed",
            winner.id,
          );
          spoken.add(winner.id);
          continue;
        }

        const finalText =
          perAgentFallbacks.length > 0
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

    return {
      decision: routed.decision,
      replies,
      fallbacks,
      prompts,
      journeyTaskUpdates,
      suggestedTasks,
      toolUses,
      reasoning: reasoningSummaries,
    };
  });
