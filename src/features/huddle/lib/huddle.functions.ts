import { createServerFn } from "@tanstack/react-start";
import { generateText, tool, stepCountIs, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage, SuggestedTaskDraft, TaskLane } from "../data/seed";
import { parseMentions, routeMessage, routeMessageLLM, laneOwnerFor, type RouterInvocation, type RouteResult } from "./routing";
import { isQuotaError, QUOTA_OUTAGE_INLINE, type FallbackEvent, type PromptDebug } from "./fallbacks";
import { buildRoster } from "./roster";
import { agentOwnsCapability, exclusiveCapabilities, capabilityOwnerFor } from "./capabilities";
import {
  detectCeremony,
  buildCeremonyReport,
  lanesByOwner,
  roundRobinParticipants,
  ownerDirective,
  closerDirective,
  narrateDirective,
  CEREMONY_WINDOW_HOURS,
  CEREMONY_HOST,
} from "./tasks/ceremonies";
import {
  TAVILY_WEB_SEARCH_TOOL,
  TAVILY_WEB_SEARCH_HINT,
  tavilySearch,
  type TavilySearchArgs,
} from "./tavily-search.functions";
import { CREATE_ARTIFACT_TOOL } from "./artifacts/artifact-tool";
import { FLAG_BLOCKER_TOOL } from "./tasks/task-agent-tools";

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
  // Scrum ceremonies: "round-robin" (default) has each lane owner voice their own
  // section and the scrum master close; "narrate" has the scrum master run it solo.
  ceremonyMode: z.enum(["round-robin", "narrate"]).optional(),
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
  " Never claim an action was actually carried out — sent, emailed, scheduled, booked, created, updated, cancelled, or completed — unless you called a tool THIS turn that performed it and it returned success. If you only drafted, proposed, or planned something, say exactly that; never state it \"has been sent\" or \"is done\" when it has not. Email specifically: text you write in the chat is \"draft text\" — only say you \"saved a draft to your inbox\" if you called the create_email_draft tool and it returned success, and only say an email was \"sent\" if send_email returned success." +
  " Tool results are ground truth: if a tool result contains an \"error\" field or otherwise reports failure, the action did NOT happen — tell the user plainly that it didn't work (one short sentence) and do NOT claim it succeeded, is scheduled, or will happen. Never paper over a failed tool with a confident success message." +
  " Your capabilities are exactly the tools you have this turn — nothing more. If you're asked or assigned something you cannot actually do with those tools (e.g. move money, buy something, take a real-world action only the user can), do NOT pretend, vaguely promise, or invent a result — say plainly in one sentence what you can't do and why. Almost always you CAN still make real progress by researching, analyzing, or drafting — do that instead. If it's a task on the board and you genuinely cannot advance it (it needs the user's decision, a credential, or a capability you don't have), call flag_blocker(task_id, reason) with the specific reason so the user knows exactly what you need." +
  " Never mention files, uploaded files, documents, attachments, or a knowledge base, and never say you searched them or \"couldn't find information in the uploaded files\" — file search is a silent background aid, not something to narrate. If it returns nothing useful, just answer the user directly from what you know, your live tools, and the conversation. Above all, ANSWER THE USER'S ACTUAL LAST MESSAGE: if they correct you (e.g. \"your time zone is wrong\") or ask something specific, address exactly that — never fall back to a canned \"I couldn't find that\" line that ignores what they just said.";

// Scope-aware ownership hand-off — generated from `agent.capabilities` (agents.ts), NOT
// hardcoded to any agent or job. Appended to every agent's instructions when the huddle
// contains at least one exclusive-capability owner. It encodes the two behaviours the user
// wants, and they differ by SCOPE:
//   • group — the owner is in the room, so whoever owns the job just DOES it and reports
//     what/why ("took care of it because …"); a non-owner neither attempts it nor files a
//     meta-task, it @mentions the owner to pull them in.
//   • 1:1  — the owner is NOT in the conversation, so the addressed agent DEFERS: it tells
//     the user the owner is better suited and that it'll let them know, and @mentions them
//     to follow up. No agent ever performs an exclusive job it doesn't own.
// This is the systematic version of the earlier grooming-only clause: it covers every
// exclusive capability of every agent, present or future, with no per-case code.
function capabilityHandoffBlock(
  scope: "group" | "1:1",
  members: readonly AgentId[],
  selfId: AgentId,
): string {
  // Which exclusive owners to surface depends on scope. GROUP: only owners actually present
  // (they can be @mentioned into the turn). 1:1: the owner is NEVER in a 1:1 (a DM has one
  // agent), so filtering by members would yield NOTHING and the addressed agent would get no
  // hand-off instruction — the exact bug where Tess improvised grooming instead of deferring.
  // Use the FULL roster in a 1:1 so ownership is known even though the owner isn't in the room.
  const owned = scope === "1:1" ? exclusiveCapabilities() : exclusiveCapabilities(members);
  if (owned.length === 0) return "";
  const directory = owned
    .map((o) => `- ${o.cap.label} → @${o.agent.handle}${o.agent.id === selfId ? " (you own this)" : ""}`)
    .join("\n");
  const rule =
    scope === "group"
      ? "If you are asked to do an exclusive job you do NOT own, do NOT attempt it and do NOT create a task about it — @mention the owner so they pick it up. If YOU own the job being asked for, just do it and briefly say what you did and why (e.g. \"took care of grooming — the backlog was stale\"); do not ask permission first or defer."
      : "This is a 1:1, so the owner is NOT in this conversation. If you are asked to do an exclusive job you do NOT own, do NOT attempt it, do NOT improvise your own version of it (no grooming pass, no proposing owner assignments), and do NOT create a task about it. Say plainly, in one warm sentence, that the owner (refer to them by NAME, e.g. \"Terry\") is better suited and that you'll have them reach out — do NOT use an @handle (they are not in this 1:1; @ is for group rooms). The system brings them in automatically. If YOU are the owner, just do it.";
  return (
    "\n\nExclusive capabilities — only the named owner may perform each:\n" +
    directory +
    "\n" +
    rule
  );
}

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

// Cross-cutting tool resilience: EVERY agent tool call is bounded by a timeout and its errors are
// turned into a normal tool RESULT (never a throw). A hung or failing tool must not sink the turn —
// the model always gets something back and can still reply ("I hit a problem with X"). Applies to
// all tools and all agents, not any single one.
const TOOL_TIMEOUT_MS = 30_000;
// A few tools do more work than a normal call (an LLM classification pass PLUS a batched write) and
// legitimately need longer than the default cap — otherwise the wrapper kills them mid-write and the
// agent reports a false "timed out". Give them a bounded-but-larger budget.
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = { groom_backlog: 55_000 };
async function runToolSafely(name: string, fn: () => Promise<unknown>): Promise<string> {
  const timeoutMs = TOOL_TIMEOUT_OVERRIDES[name] ?? TOOL_TIMEOUT_MS;
  try {
    const out = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    return typeof out === "string" ? out : JSON.stringify(out ?? {});
  } catch (e) {
    return JSON.stringify({ error: "tool_failed", tool: name, message: e instanceof Error ? e.message : String(e) });
  }
}

// Resumable mid-turn state (backlog #3). Serialized into `chat.pending_turns.progress` at a chunk
// boundary and reloaded to continue the SAME turn in a later runner execution WITHOUT re-routing or
// re-running any agent that already spoke. Sets/Maps are stored as arrays (JSON has no Set/Map). The
// dedup ledgers (createdTaskTitles / claimedActions) MUST round-trip so chunk 2 never re-creates a
// task or re-fires a reminder/email chunk 1 already did.
type TurnResumeState = {
  decision: RouteResult["decision"];
  remainingQueue: AgentId[];
  spoken: AgentId[];
  createdTaskTitles: string[];
  claimedActions: string[];
  handoffById: [AgentId, { fromName: string; ask: string }][];
  interjectors: AgentId[];
  ceremonyActive: boolean;
  ceremonyDirectives: [AgentId, string][];
  replyCap: number;
  replies: { agentId: AgentId; text: string; fallbackNotes?: string[] }[];
  journeyTaskUpdates: import("./journey/types").JourneyTask[];
  suggestedTasks: SuggestedTaskDraft[];
  toolUses: import("../data/seed").ToolUseEvent[];
  reasoning: string[];
  fallbacks: FallbackEvent[];
  prompts: PromptDebug[];
};

export interface RunHuddleTurnOpts {
  /** When present → CHUNKED/durable mode: replies stream to the store and a budget-deferred agent is
   *  persisted for continuation instead of dropped. Absent → the unchanged synchronous behavior. */
  turnId?: string;
  /** Rehydrated {@link TurnResumeState} from a prior chunk's `progress`; absent = fresh durable run. */
  resume?: unknown;
}

// The core huddle turn — shared by the client-facing server function and by
// server-to-server callers (e.g. the scheduled-ceremony route). Kept as a plain
// exported async function so a route can invoke a ceremony without an RPC hop.
//
// DUAL-PATH: with no `opts.turnId` this is the SYNCHRONOUS path (test harness, voice/meeting) — one
// execution, the 36s deadline + graceful defer, no persistence, byte-identical to before. With
// `opts.turnId` it runs in CHUNKED mode: sub-45s chunks, each agent's reply streamed to the durable
// store the instant its wave lands, and a budget-deferred agent re-queued (never dropped) so the
// runner continues the turn across executions until every routed agent has replied.
export async function runHuddleTurn(data: z.infer<typeof Input>, opts?: RunHuddleTurnOpts) {
    // Wall-clock start for the per-execution deadline (see runBounded). The whole chunk — sequential
    // primary + parallel wave(s) — must finish under the ~45s hosting request ceiling, so agents are
    // bounded by time REMAINING, not a fixed per-agent value.
    const turnStartMs = Date.now();

    // ---- Chunked/durable mode wiring (backlog #3) ----
    const turnId = opts?.turnId;
    const chunked = !!turnId;
    const resume = opts?.resume as TurnResumeState | undefined;
    // Per-CHUNK time budget: run agents until this is hit, then persist the remaining queue + ledgers
    // and stop THIS execution (a fresh runner execution continues the turn). Separate from — and below
    // — the synchronous path's 36s deadline so a chunk lands comfortably under the hosting ceiling.
    const CHUNK_BUDGET_MS = 30_000;
    const TURN_DEADLINE_MS = 36_000;
    const deadlineMs = chunked ? CHUNK_BUDGET_MS : TURN_DEADLINE_MS;
    // Runaway guard: cap the number of continuation executions. `chunks` counts boundary saves (bumped
    // by saveTurnChunk, NOT the mid-chunk streaming writes), so this is the execution count so far.
    const MAX_CHUNKS = 6;
    const turnStore = chunked ? await import("./tasks/turns.server") : null;
    let priorChunks = 0;
    if (chunked && turnId && turnStore) {
      try {
        priorChunks = (await turnStore.getTurn(turnId))?.chunks ?? 0;
      } catch {
        priorChunks = 0;
      }
    }
    const atChunkCap = priorChunks + 1 >= MAX_CHUNKS;
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
    const journeyTaskUpdates: import("./journey/types").JourneyTask[] = resume
      ? [...resume.journeyTaskUpdates]
      : [];
    const suggestedTasks: SuggestedTaskDraft[] = resume ? [...resume.suggestedTasks] : [];
    // Reasoning summaries collected across agent turns (reasoning models only).
    const reasoningSummaries: string[] = resume ? [...resume.reasoning] : [];

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

    // ---- Fallback + prompt trackers ---- (rehydrated on a resumed chunk so the final result carries
    // every prior chunk's fallbacks/prompts/toolUses, not just this chunk's).
    const fallbacks: FallbackEvent[] = resume ? [...resume.fallbacks] : [];
    const prompts: PromptDebug[] = resume ? [...resume.prompts] : [];
    const toolUses: import("../data/seed").ToolUseEvent[] = resume ? [...resume.toolUses] : [];
    let fbSeq = 0;
    let tuSeq = 0;
    function recordFallback(
      subsystem: FallbackEvent["subsystem"],
      reason: string,
      inline: string,
      agentId?: AgentId,
      severity: "warn" | "critical" = "warn",
    ): FallbackEvent {
      const ev: FallbackEvent = {
        id: `fb-${Date.now()}-${fbSeq++}`,
        ts: Date.now(),
        agentId,
        subsystem,
        reason,
        inline,
        severity,
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

    // Skip on a resumed chunk — the user message was already persisted to memory on the first chunk;
    // re-writing it every continuation would duplicate the global chunk.
    if (!resume && (anyShared || privateAgents.length > 0) && openaiKey) {
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
    // On a resumed chunk we do NOT re-route (it would waste an LLM call and could pick a different
    // responder set): the queue + decision come straight from the persisted progress. `routed` is a
    // thin shell carrying only the frozen decision; the driver reads the remaining queue, not winners.
    let routed: RouteResult;
    if (resume) {
      routed = { winners: [], interjectors: [], decision: resume.decision };
    } else {
    const explicitMentions = parseMentions(
      data.text,
      AGENTS.filter((a) => data.members.includes(a.id)),
    );
    // Group @mentions now go THROUGH the LLM router (which augments: mentioned agents are guaranteed
    // winners AND a prose-named work-owner is still routed — see routing.ts). Previously any @mention
    // forced the deterministic mention-only route, dropping the prose-named collaborator ("Tess, scope
    // X, then @cole …" → Cole only). 1:1 and missing-key still fall back to keyword routing below.
    const canLLMRoute =
      data.scope === "group" &&
      !data.targetAgentId &&
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
      // routeMessageLLM prefixes reason with "LLM fallback:" when it degrades. Quota
      // exhaustion must surface LOUDLY (critical) — a silently keyword-routed turn looks
      // normal but picks the wrong agents, so the user would never realise it's broken.
      if (routed.decision.reason.startsWith("LLM fallback")) {
        const quota = isQuotaError(routed.decision.reason);
        recordFallback(
          "router",
          routed.decision.reason,
          quota ? QUOTA_OUTAGE_INLINE : "router: LLM router failed, keyword fallback",
          undefined,
          quota ? "critical" : "warn",
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
    } // end !resume routing

    // Persist a TERMINAL result in chunked mode. Every exit — the two early returns below and the
    // normal drained-queue path — routes through here so the durable store always ends 'done'. In the
    // synchronous path this is a passthrough: no persistence, the exact same object, no `partial` key.
    const finalize = async <R extends { replies: Reply[] }>(
      resultObj: R,
    ): Promise<R | (R & { partial: boolean })> => {
      if (chunked && turnId && turnStore) {
        try {
          await turnStore.saveTurnChunk(turnId, resultObj.replies ?? [], null, true, resultObj);
        } catch (e) {
          console.error("[turn-chunk] finalize save failed", e instanceof Error ? e.message : e);
        }
        return { ...resultObj, partial: false };
      }
      return resultObj;
    };

    // ---- Scrum ceremonies ----
    // A ceremony request (stand-up, retro, sprint planning, sprint review) overrides
    // normal routing: participants become the lane owners + the scrum master, each fed
    // their real slice of the task mirror so nobody improvises progress. Round-robin by
    // default (each owner speaks, host closes); "narrate" mode runs it solo via the host.
    // On a resumed chunk the ceremony directives + active flag are rehydrated from progress and
    // detection is skipped (ceremonyType=null) — the turn was already classified on chunk 1.
    const ceremonyDirectiveById = new Map<AgentId, string>(resume?.ceremonyDirectives ?? []);
    let ceremonyActive = resume?.ceremonyActive ?? false;
    const ceremonyType = resume ? null : detectCeremony(data.text);
    if (ceremonyType) {
      // Resolve the sign-in email (possibly an alias) to the canonical journey email the mirror
      // is keyed on — otherwise an aliased login grounds the ceremony in an empty task set.
      const { resolveTaskEmail } = await import("./journey/identity");
      const email = (await resolveTaskEmail(data.caller)) ?? data.caller?.entra_email;
      if (!email) {
        const host = data.members.includes(CEREMONY_HOST) ? CEREMONY_HOST : routed.winners[0];
        return finalize({
          decision: {
            signal: "topic" as const,
            scores: {} as Partial<Record<AgentId, number>>,
            winnerId: host,
            runnerUpId: null,
            interjected: false,
            reason: `ceremony ${ceremonyType}: needs signed-in account`,
          },
          replies: [
            {
              agentId: host,
              text: `I can run the ${ceremonyType} once your account is connected — I read your real tasks to do it, and I don't have them without your sign-in.`,
            },
          ] as Reply[],
          fallbacks,
          prompts,
          journeyTaskUpdates,
          suggestedTasks,
          toolUses,
          reasoning: reasoningSummaries,
        });
      }
      try {
        const { getStandupTasks } = await import("./tasks/tasks.server");
        const tasks = await getStandupTasks(email, CEREMONY_WINDOW_HOURS[ceremonyType]);
        const report = buildCeremonyReport(ceremonyType, tasks);
        const narrate = routerCfg.ceremonyMode === "narrate";
        const host = data.members.includes(CEREMONY_HOST) ? CEREMONY_HOST : routed.winners[0];

        if (narrate || report.lanes.length === 0) {
          // Solo: the scrum master narrates (or there's simply no lane activity to round-robin).
          ceremonyDirectiveById.set(host, narrateDirective(ceremonyType, report));
          routed = {
            winners: [host],
            interjectors: [],
            decision: {
              signal: "topic",
              scores: { [host]: 1 } as Partial<Record<AgentId, number>>,
              winnerId: host,
              runnerUpId: null,
              interjected: false,
              reason: `ceremony ${ceremonyType} [narrate]`,
            },
          };
        } else {
          const participants = roundRobinParticipants(report, data.members);
          const owners = lanesByOwner(report);
          for (const p of participants) {
            if (p === CEREMONY_HOST) ceremonyDirectiveById.set(p, closerDirective(ceremonyType, report));
            else {
              const lane = owners.get(p);
              if (lane) ceremonyDirectiveById.set(p, ownerDirective(ceremonyType, lane));
            }
          }
          const scores = Object.fromEntries(
            participants.map((id, i) => [id, Number((1 - i * 0.1).toFixed(2))]),
          ) as Partial<Record<AgentId, number>>;
          routed = {
            winners: participants,
            interjectors: [],
            decision: {
              signal: "topic",
              scores,
              winnerId: participants[0],
              runnerUpId: participants[1] ?? null,
              interjected: false,
              reason: `ceremony ${ceremonyType} [round-robin] · ${participants.length} participants`,
            },
          };
        }
        ceremonyActive = ceremonyDirectiveById.size > 0;
      } catch (err) {
        recordFallback(
          "tool",
          `ceremony ${ceremonyType} failed to load tasks — ${err instanceof Error ? err.message : String(err)}`,
          "ceremony data load failed",
        );
      }
    }

    // A fresh run that routed to nobody ends empty. On resume `routed.winners` is intentionally empty
    // (the queue comes from progress), so this guard must NOT fire mid-turn.
    if (!resume && routed.winners.length === 0) {
      return finalize({
        decision: routed.decision,
        replies: [] as Reply[],
        fallbacks,
        prompts,
        journeyTaskUpdates,
        suggestedTasks,
        toolUses,
        reasoning: reasoningSummaries,
      });
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
    // On resume, the interjector membership is rehydrated (an interjector still in the remaining queue
    // must get its interjector directive when it finally runs). Otherwise derive it from the router.
    const interjectorSet = new Set<AgentId>(resume?.interjectors ?? []);
    if (!resume && routerCfg.interjections && (routerCfg.maxInterjectors ?? 2) > 0) {
      for (const id of (routed.interjectors ?? []).slice(0, routerCfg.maxInterjectors ?? 2)) {
        if (data.members.includes(id) && !routed.winners.includes(id)) interjectorSet.add(id);
      }
    }

    // Queue/spoken/replies: fresh run seeds from routing; a resumed chunk restores the exact mid-turn
    // position (remaining queue, who already spoke, and every reply so far → complete anti-repetition
    // anchor + final transcript).
    const queue: AgentId[] = resume ? [...resume.remainingQueue] : [...routed.winners, ...interjectorSet];
    const spoken = new Set<AgentId>(resume?.spoken ?? []);
    const replies: Reply[] = resume ? [...resume.replies] : [];

    // Embedding of the user's message for AUTO memory retrieval, computed at most once per turn
    // (undefined = not yet computed, null = embedding failed). Recall must not depend on the model
    // electing to call `search_memory`: we proactively pull the most relevant SHARED/global memory
    // into each responding agent's prompt. This is what carries context across huddles (e.g. a fact
    // stated in the group channel is available in a later 1:1) without the agent having to ask.
    let memoryQueryVec: number[] | null | undefined;

    // Normalized titles of tasks already created THIS turn, so multiple responding agents (or a
    // re-run of the same turn) can't create duplicate board cards for one intent. See
    // createSuggestedTaskFromTool below, which claims a title here before writing.
    const createdTaskTitles = new Set<string>(resume?.createdTaskTitles ?? []);

    // Cross-turn / cross-run dedup for create_huddle_task. `createdTaskTitles` only guards WITHIN a
    // turn; the board clutter came from the SAME task being (re)created across many turns/test runs.
    // Load the user's already-open task titles ONCE per turn from the mirror and skip creating a
    // duplicate of one that already exists. Best-effort: a failed read never blocks task creation.
    const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
    let existingOpenTitles: Set<string> | null = null;
    async function loadExistingOpenTitles(): Promise<Set<string>> {
      if (existingOpenTitles) return existingOpenTitles;
      const set = new Set<string>();
      try {
        const email = data.caller?.entra_email;
        if (email) {
          const { resolveTaskEmail } = await import("./journey/identity");
          const resolved = (await resolveTaskEmail(data.caller ?? {})) ?? email;
          const { getTasksForUser } = await import("./tasks/tasks.server");
          for (const t of await getTasksForUser(resolved)) {
            if (t.title) set.add(normTitle(t.title));
          }
        }
      } catch {
        /* dedup read is best-effort — never block a create on it */
      }
      existingOpenTitles = set;
      return set;
    }

    // 1:1 owner follow-up delivery (AC-4): when a non-owner defers in a DM ("Terry's better suited,
    // I'll let them know" + @mention), the owner isn't in the room and nothing re-queues them — the
    // promise was a dead end. This makes it real: the owner posts a message into their OWN DM
    // (dm-<owner>) AND we push the user, so they actually hear back. Fire-and-forget, once per owner
    // per turn, best-effort. Only in a 1:1 (group turns bring the owner in via the normal re-queue).
    const followupDelivered = new Set<AgentId>();
    async function deliverOwnerFollowup(ownerId: AgentId, fromName: string, ask: string): Promise<void> {
      try {
        const owner = AGENT_BY_ID[ownerId];
        if (!owner) return; // caller already guards ownerId !== the deferring agent
        const cleanAsk = ask.replace(/\s+/g, " ").trim().slice(0, 240);
        const ownerHuddle = `dm-${ownerId}`;
        const email = data.caller?.entra_email ?? null;
        // The context package handed to the owner. Careful language: the owner was TAPPED/PASSED by
        // the addressed agent and is replying in ITS OWN 1:1 with the user — it did NOT join the other
        // agent's conversation. (Delivered as the turn's user-text; the client renders only the reply.)
        const directive =
          `You are ${owner.name}. ${fromName} just tapped you and passed something your way: the user, ` +
          `in their separate 1:1 with ${fromName}, asked — "${cleanAsk}". You are now replying in YOUR OWN ` +
          `1:1 channel with the user; you did NOT join ${fromName}'s conversation. Send ONE brief, warm ` +
          `opening message: greet the user, say ${fromName} passed this to you and briefly why (reference the ` +
          `ask in your own words), and offer to take it from here — ask them to confirm before you act. Do ` +
          `not restate ${fromName} verbatim, and do not perform the work yet.`;
        // Enqueue a REAL durable turn in the owner's DM. It rides the proven path: the runner produces
        // the owner's reply, persists it, and fires the away-notification (send_push → Android bridge) —
        // exactly like any other reply. Idempotent id so a retry can't double-post.
        const id = `followup-${data.huddleId}-${ownerId}-${cleanAsk.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
        const followupPayload = {
          text: directive,
          huddleId: ownerHuddle,
          scope: "one-to-one",
          members: [ownerId],
          targetAgentId: ownerId,
          history: [],
          router: data.router,
          agents: data.agents,
          timeZone: data.timeZone,
          caller: data.caller,
        };
        const { enqueueTurn } = await import("./tasks/turns.server");
        const fresh = await enqueueTurn(id, ownerHuddle, email, followupPayload);
        if (fresh) void kickNextChunk(id); // run it now; the pg_cron drain backstops a lost kick
      } catch {
        /* follow-up delivery is best-effort — never fail the user's turn on it */
      }
    }

    // Decision rights: a turn-scoped ledger of mutating actions already performed this turn, keyed by
    // (tool + normalized args). The FIRST responding agent to perform an action "owns" it; a second
    // winner's identical call is a no-op. Generalizes the task dedup to reminders, emails, and journey
    // writes so two agents in a group turn can't double-fire the same intent. `claimAction` returns
    // false when the action was already done (caller should skip). Read-only tools are never ledgered.
    const turnActionLedger = new Set<string>(resume?.claimedActions ?? []);
    const claimAction = (key: string): boolean => {
      const k = key.trim().toLowerCase().slice(0, 240);
      if (turnActionLedger.has(k)) return false;
      turnActionLedger.add(k);
      return true;
    };

    // Lightweight handoff contract for the ad-hoc mention-chain: when an agent @mentions a teammate
    // (the "mention IS the handoff"), we re-queue that teammate — but today they receive no structured
    // ask, only the raw reply as context. Record { fromName, ask } here so the mentionee gets a crisp
    // "you were handed this, address exactly it" directive (mirrors the ceremony directive pattern).
    // Ceremonies carry their own directives; grooming is single-agent — this only fills the ad-hoc gap.
    const handoffById = new Map<AgentId, { fromName: string; ask: string }>(resume?.handoffById ?? []);

    // A broadcast ("everyone introduce yourselves") means every member should
    // get to speak, so lift the normal per-turn reply cap for that case.
    const { isBroadcast } = await import("./routing");
    const broadcastTurn = data.scope === "group" && isBroadcast(data.text);
    const replyCap =
      broadcastTurn || ceremonyActive
        ? Math.min(data.members.length, 12)
        : MAX_REPLIES_PER_TURN + interjectorSet.size;

    // Per-agent turn body, extracted so the driver can run agents either
    // SEQUENTIALLY (ceremonies) or CONCURRENTLY (normal group turns). It writes
    // only to PER-AGENT buffers (returned below) plus the turn-scoped dedup
    // ledgers (`createdTaskTitles` / `claimAction`, first-writer-wins and safe
    // under concurrency because their has→add is synchronous). The driver merges
    // the buffers in queue order and solely owns replies/spoken/queue/handoffById,
    // so the transcript is deterministic regardless of completion order. The
    // `priorInThisTurn` anti-repetition context is passed in FROZEN — parallel
    // wave agents all see the same snapshot and never each other's replies.
    type AgentTurnResult = {
      fallbacks: FallbackEvent[];
      toolUses: import("../data/seed").ToolUseEvent[];
      journeyTaskUpdates: import("./journey/types").JourneyTask[];
      suggestedTasks: SuggestedTaskDraft[];
      reasoning: string[];
      prompts: PromptDebug[];
      outcome:
        | { kind: "skip" }
        | { kind: "hardReply"; reply: Reply }
        | { kind: "reply"; clean: string; isInterjector: boolean; perAgentFallbacks: string[] };
    };
    const runAgentTurn = async (
      nextId: AgentId,
      priorInThisTurn: string,
    ): Promise<AgentTurnResult> => {
      const winner = AGENT_BY_ID[nextId]!;
      const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };

      // Per-agent output buffers. These SHADOW the outer shared arrays/helpers so
      // the (unmodified) dispatch body writes here; the driver merges them into
      // the shared arrays in queue order after the wave settles (append-only).
      const fallbacks: FallbackEvent[] = [];
      const toolUses: import("../data/seed").ToolUseEvent[] = [];
      const journeyTaskUpdates: import("./journey/types").JourneyTask[] = [];
      const suggestedTasks: SuggestedTaskDraft[] = [];
      const reasoningSummaries: string[] = [];
      const prompts: PromptDebug[] = [];
      let fbSeq = 0;
      let tuSeq = 0;
      const recordFallback = (
        subsystem: FallbackEvent["subsystem"],
        reason: string,
        inline: string,
        agentId?: AgentId,
        severity: "warn" | "critical" = "warn",
      ): FallbackEvent => {
        const ev: FallbackEvent = {
          id: `fb-${Date.now()}-${winner.id}-${fbSeq++}`,
          ts: Date.now(),
          agentId,
          subsystem,
          reason,
          inline,
          severity,
        };
        fallbacks.push(ev);
        return ev;
      };
      const recordToolUse = (
        agentId: AgentId,
        tool: string,
        summary: string,
        ok: boolean,
        detail?: string,
      ) => {
        toolUses.push({
          id: `tu-${Date.now()}-${winner.id}-${tuSeq++}`,
          ts: Date.now(),
          agentId,
          tool,
          summary,
          ok,
          detail,
        });
      };
      // Snapshot the fully-populated buffers into a result. Called at each return
      // point (after all pushes), so the buffers are complete.
      const bundle = (outcome: AgentTurnResult["outcome"]): AgentTurnResult => ({
        fallbacks,
        toolUses,
        journeyTaskUpdates,
        suggestedTasks,
        reasoning: reasoningSummaries,
        prompts,
        outcome,
      });

      const ceremonyDirective = ceremonyDirectiveById.get(nextId) ?? "";
      const handoff = handoffById.get(nextId);
      const handoffDirective = handoff
        ? `\n\nYou were brought into this turn by ${handoff.fromName}, who handed this to you: "${handoff.ask}". Address exactly that in your lane — answer it directly or take the action they need. Do not re-ask what was already said or restate their message.`
        : "";
      // Domain/theme lane hand-off (1:1 only — group turns already route to the right lane). If the
      // user's ask clearly belongs to another agent's lane (by domains/themes, e.g. "tighten my
      // budget" → Finn), tell THIS agent to defer and bring them in, even though that owner isn't in
      // the room. Deterministic + data-driven, so it covers every lane, not just the tool-owned ones.
      let laneDirective = "";
      if (data.scope !== "group") {
        const owner = laneOwnerFor(data.text, nextId);
        if (owner && owner.id !== nextId) {
          const o = AGENT_BY_ID[owner.id];
          laneDirective = `\n\nThis request is squarely in ${o.name}'s lane (${o.role}: ${o.domains.slice(0, 3).join(", ")}), not yours. Do NOT answer it yourself or improvise in their lane — tell the user plainly, by NAME, that ${o.name} is better suited and that you'll loop them in (e.g. "That's really ${o.name}'s area — let me pass it to them"). Do NOT use an @handle: ${o.name} is not in this 1:1 (@ is for group rooms). The system brings ${o.name} in automatically — they'll follow up with you in their own channel. Keep it to one or two short sentences.`;
        }
      }
      const isInterjector = interjectorSet.has(nextId);
      const interjectDirective = isInterjector
        ? `\n\nYou were NOT asked directly. Interject ONLY if you can add something URGENT the primary MISSED — one of exactly these two:
1. A MISSING PIECE the primary needs to get this right that only your lane holds — a specific number, constraint, fact, or a check the primary got wrong or omitted (e.g. "That GTM math skips CAC, so the payback won't hold").
2. A BLOCKING RISK or CONFLICT in your lane the primary didn't flag — a schedule clash, a budget/deadline/dependency/compliance blocker, a commitment already made.
Do NOT repeat, restate, agree with, second-opinion, or add color to what the primary said. If you have live tools (schedule/tasks/contacts), check them FIRST. Then:
- ONLY if you have something concrete that is blocking or completing, reply with ONLY that, one short sentence, leading with the value — e.g. "Heads up — you already have a 12pm investor call."
- Otherwise — nothing concrete, only agreement/color, or you have no tools/data to check — reply with exactly the single word: PASS (nothing before or after it).`
        : "";

      const scene = ` You are ${winner.name} in a ${
        data.scope === "group" ? "group huddle" : "1:1"
      }. Reply naturally, as yourself, in-character — like you're talking in a room with real people. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to". Do not speak as anyone else. 1–3 short sentences unless asked for detail.${
        priorInThisTurn && !ceremonyDirective
          ? `\n\nOther agents ALREADY replied in this same turn:\n${priorInThisTurn}\nDo NOT restate, re-answer, paraphrase, or agree with what they said — the user already read it. Contribute ONLY the distinct piece your own lane owns that they did not cover. If you have nothing to add beyond what's been said, reply with a single short sentence deferring to them (e.g. "nothing to add — @finn-reid covered it"). Never repeat another agent's answer back.`
          : ""
      }${interjectDirective}${ceremonyDirective}${handoffDirective}${laneDirective}`;

      const roster = buildRoster(data.members, winner.id);
      // Data-driven, scope-aware ownership hand-off (agents.ts capabilities). Empty string
      // when no exclusive-capability owner is in this huddle, so zero prompt overhead then.
      const capabilityBlock = capabilityHandoffBlock(
        data.scope === "group" ? "group" : "1:1",
        data.members,
        winner.id,
      );
      const taskToolInstructions =
        "\n\nYou have a `create_huddle_task` tool. When the user asks to add, create, log, track, assign, capture, or put a task/action item on the board, call `create_huddle_task` before answering. It creates a suggested board card for user approval; do not merely say you will add it." +
        " NEVER use it to create a task that merely restates an action you were asked to PERFORM (e.g. a card titled \"groom the backlog\" or \"assign the team\") — that is not a to-do, it is the thing you were asked to do: perform it, or hand it to the agent who can. Only create tasks for genuine future work the user wants tracked.";

      // AUTO memory retrieval: pull the most relevant shared/global memory for THIS agent and inject
      // it into the prompt, so recall works even when the model doesn't call `search_memory`. This is
      // the fix for "forgot two lines ago" across huddles — history is per-huddle, but memory is not.
      let memoryBlock = "";
      const ragCfg = agentBackend.rag;
      if (ragCfg && ragCfg.store === "azure" && ragCfg.chunks && openaiKey) {
        try {
          if (memoryQueryVec === undefined) {
            const { embed } = await import("./rag/embed.server");
            try {
              memoryQueryVec = await embed(data.text);
            } catch {
              memoryQueryVec = null; // embedding unavailable — skip auto-retrieval this turn
            }
          }
          if (memoryQueryVec) {
            const { azurePgStore } = await import("./rag/azure-pg.server");
            const hits = await azurePgStore.searchChunks({
              query: data.text,
              queryVec: memoryQueryVec,
              agentId: winner.id,
              mode: ragCfg.sharing ?? "shared",
              k: 6,
            });
            // Exclude the current message and anything already in this huddle's recent transcript,
            // so we surface only context the model wouldn't otherwise have (older / other-huddle).
            const alreadyVisible = new Set(
              [data.text, ...data.history.slice(-14).map((m) => m.text)].map((t) => t.trim()),
            );
            // Relevance floor calibrated for text-embedding-3-large, whose cosine scores run LOWER
            // than older models: a strong topical match (e.g. "what is my dog's name?" vs a stored
            // "my dog's name is Waffles") measures ~0.42, and unrelated text sits below ~0.25. The old
            // 0.72 floor silently dropped every real hit. 0.3 keeps genuine matches, rejects noise.
            const MEMORY_MIN_SCORE = 0.3;
            // Role/domain-aware re-rank: within the relevance floor, gently prefer memory that matches
            // THIS agent's lane — its domains/themes appear in the chunk, or it co-authored the chunk —
            // so each agent surfaces the memory most relevant to what it actually owns, instead of the
            // same generic top-K for everyone. Pure reorder over already-relevant hits (no SQL change).
            const laneTerms = [...winner.domains, ...winner.themes]
              .map((t) => t.toLowerCase())
              .filter((t) => t.length >= 3);
            const laneBoost = (h: { text?: string; authorAgentIds?: string[] }) => {
              const t = (h.text || "").toLowerCase();
              const termHit = laneTerms.some((kw) => t.includes(kw)) ? 0.12 : 0;
              const authorHit = h.authorAgentIds?.includes(winner.id) ? 0.06 : 0;
              return termHit + authorHit;
            };
            const fresh = (hits ?? [])
              .filter((h) => (h.score ?? 0) >= MEMORY_MIN_SCORE && !alreadyVisible.has(h.text.trim()))
              .sort((a, b) => ((b.score ?? 0) + laneBoost(b)) - ((a.score ?? 0) + laneBoost(a)))
              .slice(0, 4);
            if (fresh.length) {
              memoryBlock =
                "\n\nRelevant memory from earlier conversations (use only if it helps answer; do not repeat it verbatim or announce that you looked it up):\n" +
                fresh.map((h) => `- ${h.text}`).join("\n");
            }
          }
        } catch {
          /* memory retrieval is best-effort — never block or fail the reply */
        }
      }

      const appSystem =
        winner.systemPrompt +
        scene +
        roster +
        taskToolInstructions +
        capabilityBlock +
        memoryBlock +
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
        /\b(add|create|make|log|track|put|place|capture|assign|todo|to-do|action item|follow[- ]?up)\b/i;
      // A reminder ("remind me in 30 min", "ping me at 3pm") is a timed nudge, NOT a backlog task —
      // route it to schedule_reminder and DON'T also force a task/web-search for the same message.
      const reminderRe =
        /\b(remind me|reminder|notify me|ping me|nudge me|alert me|wake me|set an alarm|alarm|message me (?:in|at|later|tonight|tomorrow)|text me (?:in|at))\b/i;
      const forceReminder = reminderRe.test(data.text);
      // Only the PRIMARY responder is forced to create the task. Interjectors surface information;
      // forcing them to also create produced duplicate cards (e.g. Troy AND Iris both creating).
      const forceTaskCreation = !forceReminder && !isInterjector && createTaskRe.test(data.text);
      const forceWebSearch = !forceReminder && !!agentBackend.webSearch && timeSensitiveRe.test(data.text);

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
        // Exclusive-capability meta-task guard (deterministic; data-driven off capability triggers).
        // A non-owner must NOT file a task that merely restates an EXCLUSIVE job it does not own
        // (e.g. Iris filing "Groom and triage the backlog" — Terry's job). The owner was already
        // handed the ask via the back-channel, so the card would be pure clutter. Two prose
        // prohibitions (taskToolInstructions + capabilityHandoffBlock) proved unreliable on a small
        // model, so enforce in code. Fires ONLY when the TITLE itself matches a capability trigger
        // AND the filer isn't the owner — a genuine to-do ("renew passport") matches nothing and is
        // untouched. Covers every agent/capability, mirroring the groom_backlog exclusive-tool gate.
        const titleOwner = capabilityOwnerFor(title);
        if (titleOwner && titleOwner.agent.id !== winner.id) {
          recordToolUse(
            winner.id,
            "create_huddle_task",
            `blocked meta-task “${title.slice(0, 60)}” — ${titleOwner.cap.label} belongs to ${titleOwner.agent.name}`,
            true,
          );
          return {
            ok: true,
            deferred: true,
            handedTo: titleOwner.agent.id,
            note: `That's ${titleOwner.agent.name}'s exclusive job — it's been handed to them; do not file a task about it.`,
          };
        }
        // Cross-agent / re-run dedup: if this exact title was already created earlier in this turn,
        // don't create a second card. The first caller claims the title here.
        const titleKey = title.trim().toLowerCase();
        if (createdTaskTitles.has(titleKey)) {
          recordToolUse(winner.id, "create_huddle_task", "already created this turn — skipped duplicate", true);
          return { ok: true, deduped: true, task: { title: title.slice(0, 160) } };
        }
        // Cross-turn dedup: skip if an open task with this title already exists on the board.
        const existing = await loadExistingOpenTitles();
        if (existing.has(normTitle(title))) {
          createdTaskTitles.add(titleKey);
          recordToolUse(winner.id, "create_huddle_task", "an open task with this title already exists — skipped duplicate", true);
          return { ok: true, deduped: true, task: { title: title.slice(0, 160) } };
        }
        createdTaskTitles.add(titleKey);
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
          const webInstructions = agentBackend.webSearch ? "\n\n" + TAVILY_WEB_SEARCH_HINT : "";
          const { PRIORITIZE_SYSTEM_HINT } = await import("./tasks/tools");
          // Grooming is now gated on the data-driven capability (agents.ts), with the legacy
          // id/special check kept as a non-destructive fallback so nothing regresses.
          const ownsGrooming =
            agentOwnsCapability(winner, "backlog-grooming") ||
            winner.id === "terry-locke" ||
            winner.special === "standup-host";
          let groomHint = "";
          if (ownsGrooming) {
            const groom = await import("./tasks/groom");
            // Scope-aware hand-off: group → do-and-report; 1:1 → defer + confirm first.
            groomHint =
              "\n\n" +
              groom.GROOM_SYSTEM_HINT +
              (data.scope === "group" ? groom.GROOM_HANDOFF_DO_HINT : groom.GROOM_HANDOFF_CONFIRM_HINT);
          }
          const { REMINDER_SYSTEM_HINT } = await import("./tasks/reminders");
          // Cache-friendly ordering (see the "prompt-payload efficiency" backlog item): put ALL
          // STABLE content first — persona/snapshot + roster + tool hints + house-style — so OpenAI
          // automatic prompt caching keys on a large prefix that's byte-identical across this agent's
          // turns; put VOLATILE content last — the turn-specific scene, retrieved memory, and the
          // current-time grounding. This is a pure REORDER (nothing removed; additive-rule safe), and
          // it cuts the uncached input tokens per call, which lowers cost + TPM pressure (the throttle
          // that inflates multi-agent latency). Turn-specific directives sitting last also aids
          // instruction adherence via recency. Paired with a per-agent `promptCacheKey` for routing.
          const stableInstructions =
            (effectiveInstructions || winner.systemPrompt) +
            roster +
            taskToolInstructions +
            capabilityBlock +
            HOUSE_STYLE +
            ragInstructions +
            webInstructions +
            "\n\n" + PRIORITIZE_SYSTEM_HINT +
            groomHint +
            "\n\n" + REMINDER_SYSTEM_HINT;
          const volatileInstructions =
            scene + memoryBlock + groundingBlock(!!agentBackend.webSearch);
          const instructions = stableInstructions + volatileInstructions;
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
            emailTools.push({
              type: "function" as const,
              name: "get_calendar_events",
              description:
                "Read the user's Microsoft/Outlook calendar for a day or range and return the actual events (meetings, appointments). Use this whenever the user asks what's on their calendar/schedule/agenda for a day, or whether they're free/busy at a time. This reads REAL calendar data — never answer calendar questions from memory or 'files'. Dates are ISO (YYYY-MM-DD or full ISO datetime). Note: returns Microsoft/Outlook events; a Google-only calendar won't appear.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  start: {
                    type: "string",
                    description: "Start of the range, ISO date or datetime (e.g. 2026-07-21). Defaults to today.",
                  },
                  end: {
                    type: "string",
                    description: "End of the range, ISO date or datetime. Defaults to the end of the start day.",
                  },
                },
                required: [],
              },
              strict: false,
            });
          }

          const { PRIORITIZE_TOOL } = await import("./tasks/tools");
          // The scrum master alone gets the backlog-grooming tool (Jira-style triage/assign).
          const groomTools = ownsGrooming ? [(await import("./tasks/groom")).GROOM_BACKLOG_TOOL] : [];
          const { SCHEDULE_REMINDER_TOOL } = await import("./tasks/reminders");
          const mergedTools = [
            createHuddleTaskTool,
            CREATE_ARTIFACT_TOOL,
            FLAG_BLOCKER_TOOL,
            SCHEDULE_REMINDER_TOOL,
            PRIORITIZE_TOOL,
            ...groomTools,
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
            if (c.name === "create_artifact") {
              const a = c.arguments as Record<string, unknown>;
              const name = String(a.name ?? "").trim();
              const content = String(a.content ?? "");
              if (!name || !content) return JSON.stringify({ ok: false, error: "name and content are required" });
              if (!claimAction(`create_artifact:${a.task_id ?? ""}:${name}`)) {
                recordToolUse(winner.id, "create_artifact", "already saved this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true });
              }
              try {
                const email =
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email;
                if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
                const { createArtifact } = await import("./artifacts/artifacts.server");
                const { id, deepLink } = await createArtifact({
                  userEmail: email,
                  agentId: winner.id,
                  taskId: a.task_id ? String(a.task_id) : null,
                  folder: String(a.folder ?? "Research"),
                  name,
                  mime: String(a.mime ?? "text/markdown"),
                  bytes: Buffer.from(content, "utf8"),
                });
                recordToolUse(winner.id, "create_artifact", `saved "${name}"`, true, deepLink);
                return JSON.stringify({ ok: true, id, deepLink });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "create_artifact", "save failed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            }
            if (c.name === "flag_blocker") {
              const a = c.arguments as Record<string, unknown>;
              const taskId = String(a.task_id ?? "").trim();
              const reason = String(a.reason ?? "").trim();
              if (!taskId || !reason) return JSON.stringify({ ok: false, error: "task_id and reason are required" });
              if (!claimAction(`flag_blocker:${taskId}`)) {
                recordToolUse(winner.id, "flag_blocker", "already flagged this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true });
              }
              try {
                const email =
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email;
                if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
                // Record the specific reason Huddle-native (holds the "why"; journey has no reason field).
                const { setTaskBlocker } = await import("./tasks/tasks.server");
                await setTaskBlocker(email, taskId, reason, winner.id);
                // Set the journey task status=BLOCKED so journey ↔ Huddle stay in sync (it syncs back to
                // the mirror). CHECK the result — a silent failure here means the two apps disagree.
                // Set the journey task status=BLOCKED so journey ↔ Huddle stay in sync (it syncs back to
                // the mirror in ~1s–1min; the reverse — an unblock on journey — clears the reason row via
                // upsertJourneyTask). Check the result so a silent board-write failure is surfaced.
                let boardStatusSet = false;
                let boardError = "";
                try {
                  const { invokeJourneyTool } = await import("./journey/proxy.functions");
                  const r = await invokeJourneyTool({
                    toolName: "update_task",
                    args: { task_id: taskId, status: "BLOCKED" },
                    caller: data.caller ?? {},
                    context: { source: "huddle" },
                  });
                  boardStatusSet = !!r.ok;
                  if (!r.ok) boardError = String(r.error ?? r.output ?? "update_task_failed").slice(0, 160);
                } catch (e) {
                  boardError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
                }
                recordToolUse(
                  winner.id,
                  "flag_blocker",
                  boardStatusSet ? `blocked: ${reason.slice(0, 50)}` : `blocked, board status not set: ${boardError}`,
                  true,
                  boardError || undefined,
                );
                return JSON.stringify({ ok: true, task_id: taskId, board_status_set: boardStatusSet });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "flag_blocker", "flag failed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            }
            if (c.name === "schedule_reminder") {
              const a = c.arguments as Record<string, unknown>;
              if (!claimAction(`reminder:${a.text ?? ""}:${a.delay_minutes ?? ""}:${a.at_time ?? ""}`)) {
                recordToolUse(winner.id, "schedule_reminder", "already scheduled this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true, message: "That reminder was already scheduled this turn." });
              }
              const { dispatchScheduleReminder } = await import("./tasks/reminders");
              const out = await dispatchScheduleReminder(data.caller, c.arguments, data.huddleId, winner.id, data.timeZone);
              const ok = !JSON.parse(out).error;
              recordToolUse(winner.id, "schedule_reminder", ok ? "reminder scheduled" : "reminder · failed", ok);
              return out;
            }
            if (c.name === "prioritize") {
              const { dispatchPrioritize } = await import("./tasks/tools");
              return dispatchPrioritize(
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email,
                c.arguments,
              );
            }
            if (c.name === "groom_backlog") {
              const { dispatchGroomBacklog } = await import("./tasks/groom");
              const out = await dispatchGroomBacklog(data.caller, c.arguments);
              let groomDetail = "";
              try {
                const p = JSON.parse(out) as { _timings?: { readMs: number; classifyMs: number; writeMs: number; tasks: number } };
                if (p._timings) groomDetail = `read=${p._timings.readMs}ms classify=${p._timings.classifyMs}ms write=${p._timings.writeMs}ms tasks=${p._timings.tasks}`;
              } catch { /* ignore */ }
              recordToolUse(winner.id, "groom_backlog", "groomed the backlog", true, groomDetail);
              return out;
            }
            if (c.name === "send_email") {
              const a = c.arguments as Record<string, unknown>;
              if (!claimAction(`send_email:${a.to ?? ""}:${a.subject ?? ""}`)) {
                recordToolUse(winner.id, "send_email", "already sent this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true, message: "That email was already sent this turn." });
              }
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
              if (!claimAction(`create_email_draft:${a.to ?? ""}:${a.subject ?? ""}`)) {
                recordToolUse(winner.id, "create_email_draft", "already drafted this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true, message: "That draft was already created this turn." });
              }
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
            if (c.name === "get_calendar_events") {
              const a = c.arguments as Record<string, unknown>;
              try {
                const tz = data.timeZone || "UTC";
                const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
                const startRaw = typeof a.start === "string" && a.start.trim() ? a.start.trim() : todayStr;
                const endRaw = typeof a.end === "string" && a.end.trim() ? a.end.trim() : startRaw;
                const startDay = startRaw.slice(0, 10);
                const endDay = endRaw.slice(0, 10);
                const startISO = startRaw.length > 10 ? startRaw : `${startDay}T00:00:00`;
                const endISO = endRaw.length > 10 ? endRaw : `${endDay}T23:59:59`;
                const mailbox =
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email;
                const { getGraphCalendarEvents } = await import("./email/graph-email.server");
                const r = await getGraphCalendarEvents({ mailbox, startISO, endISO, timeZone: tz });
                recordToolUse(
                  winner.id,
                  "get_calendar_events",
                  r.ok
                    ? `${r.events?.length ?? 0} event(s) ${startDay}${endDay !== startDay ? `..${endDay}` : ""}`
                    : "calendar read failed",
                  r.ok,
                  r.ok ? undefined : r.error,
                );
                if (!r.ok) {
                  const ev = recordFallback(
                    "tool",
                    `${winner.name}: get_calendar_events failed — ${r.error ?? "unknown"}`,
                    "get_calendar_events failed",
                    winner.id,
                  );
                  perAgentFallbacks.push(ev.inline);
                }
                return JSON.stringify(r);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "get_calendar_events", "calendar read crashed", false, msg);
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

          const toolChoice = forceReminder
            ? { type: "function", name: "schedule_reminder" }
            : forceTaskCreation
              ? { type: "function", name: "create_huddle_task" }
              : forceWebSearch
                ? { type: "function", name: "tavily_web_search" }
                : undefined;

          if (forceReminder) {
            recordToolUse(winner.id, "schedule_reminder", "offered (forced — reminder request)", true);
          } else if (forceTaskCreation) {
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
            onToolCall: (c) => runToolSafely(c.name, () => combinedOnToolCall(c)),
            toolChoice,
            maxToolHops: 5,
            // Route this agent's requests to its own cached prefix (stable snapshot/tools/roster).
            promptCacheKey: `huddle-${winner.id}`,
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
            prompts.push({
              agentId: winner.id,
              backend: "lovable",
              model: usedModel,
              instructions: usedInstructions,
              fromSnapshot: false,
              toolTypes: [],
            });
            return bundle({
              kind: "hardReply",
              reply: {
                agentId: winner.id,
                text: `(fallback: ${ev.inline}) AI gateway is not configured yet.`,
                fallbackNotes: [ev.inline],
              },
            });
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

          // create_artifact — save the agent's own finished work as a reviewable artifact (mirrors OpenAI path).
          lovableTools.create_artifact = tool({
            description: CREATE_ARTIFACT_TOOL.description,
            inputSchema: z.object({
              name: z.string(),
              content: z.string(),
              folder: z.string().optional(),
              task_id: z.string().optional(),
              mime: z.string().optional(),
            }),
            execute: async (args) => {
              const a = args as Record<string, unknown>;
              const name = String(a.name ?? "").trim();
              const content = String(a.content ?? "");
              if (!name || !content) return JSON.stringify({ ok: false, error: "name and content are required" });
              if (!claimAction(`create_artifact:${a.task_id ?? ""}:${name}`)) {
                recordToolUse(winner.id, "create_artifact", "already saved this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true });
              }
              try {
                const email =
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email;
                if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
                const { createArtifact } = await import("./artifacts/artifacts.server");
                const { id, deepLink } = await createArtifact({
                  userEmail: email,
                  agentId: winner.id,
                  taskId: a.task_id ? String(a.task_id) : null,
                  folder: String(a.folder ?? "Research"),
                  name,
                  mime: String(a.mime ?? "text/markdown"),
                  bytes: Buffer.from(content, "utf8"),
                });
                recordToolUse(winner.id, "create_artifact", `saved "${name}"`, true, deepLink);
                return JSON.stringify({ ok: true, id, deepLink });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "create_artifact", "save failed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            },
          });

          // flag_blocker — the agent earns the "blocked" verdict by working the task (mirrors OpenAI path).
          lovableTools.flag_blocker = tool({
            description: FLAG_BLOCKER_TOOL.description,
            inputSchema: z.object({ task_id: z.string(), reason: z.string() }),
            execute: async (args) => {
              const a = args as Record<string, unknown>;
              const taskId = String(a.task_id ?? "").trim();
              const reason = String(a.reason ?? "").trim();
              if (!taskId || !reason) return JSON.stringify({ ok: false, error: "task_id and reason are required" });
              if (!claimAction(`flag_blocker:${taskId}`)) {
                recordToolUse(winner.id, "flag_blocker", "already flagged this turn — skipped duplicate", true);
                return JSON.stringify({ ok: true, deduped: true });
              }
              try {
                const email =
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                  data.caller?.entra_email;
                const { invokeJourneyTool } = await import("./journey/proxy.functions");
                await invokeJourneyTool({
                  toolName: "update_task",
                  args: { task_id: taskId, status: "BLOCKED" },
                  caller: data.caller ?? {},
                  context: { source: "huddle" },
                });
                if (email) {
                  const { setTaskBlocker } = await import("./tasks/tasks.server");
                  await setTaskBlocker(email, taskId, reason, winner.id);
                }
                recordToolUse(winner.id, "flag_blocker", `blocked: ${reason.slice(0, 60)}`, true);
                return JSON.stringify({ ok: true, task_id: taskId, status: "BLOCKED" });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordToolUse(winner.id, "flag_blocker", "flag failed", false, msg);
                return JSON.stringify({ ok: false, error: msg });
              }
            },
          });

          // schedule_reminder — Huddle-native timed reminder (mirrors the OpenAI path).
          {
            const { dispatchScheduleReminder, SCHEDULE_REMINDER_TOOL: RTOOL } = await import("./tasks/reminders");
            lovableTools.schedule_reminder = tool({
              description: RTOOL.description,
              inputSchema: z.object({
                text: z.string(),
                delay_minutes: z.number().optional(),
                at_time: z.string().optional(),
              }),
              execute: async (args) => {
                const a = args as Record<string, unknown>;
                if (!claimAction(`reminder:${a.text ?? ""}:${a.delay_minutes ?? ""}:${a.at_time ?? ""}`)) {
                  recordToolUse(winner.id, "schedule_reminder", "already scheduled this turn — skipped duplicate", true);
                  return JSON.stringify({ ok: true, deduped: true, message: "That reminder was already scheduled this turn." });
                }
                const out = await dispatchScheduleReminder(
                  data.caller,
                  a,
                  data.huddleId,
                  winner.id,
                  data.timeZone,
                );
                const ok = !JSON.parse(out).error;
                recordToolUse(winner.id, "schedule_reminder", ok ? "reminder scheduled" : "reminder · failed", ok);
                return out;
              },
            });
          }

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
                dispatchPrioritize(
                  (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                    data.caller?.entra_email,
                  args as Record<string, unknown>,
                ),
            });
          }

          // groom_backlog — gated on the data-driven grooming capability (agents.ts), with the
          // legacy id/special check kept as a non-destructive fallback (mirrors the OpenAI path).
          if (
            agentOwnsCapability(winner, "backlog-grooming") ||
            winner.id === "terry-locke" ||
            winner.special === "standup-host"
          ) {
            const { dispatchGroomBacklog } = await import("./tasks/groom");
            lovableTools.groom_backlog = tool({
              description:
                "Groom/triage the backlog like a scrum master: assign each task to the best-fit agent, tag, prioritize, and mark do/schedule/blocked per the team's real capabilities. Writes assignments + priority back to the task board.",
              inputSchema: z.object({ category: z.string().optional(), limit: z.number().optional() }),
              execute: async (args) => dispatchGroomBacklog(data.caller, args as Record<string, unknown>),
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
                  if (!claimAction(`send_email:${a.to ?? ""}:${a.subject ?? ""}`)) {
                    recordToolUse(winner.id, "send_email", "already sent this turn — skipped duplicate", true);
                    return JSON.stringify({ ok: true, deduped: true, message: "That email was already sent this turn." });
                  }
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
                  if (!claimAction(`create_email_draft:${a.to ?? ""}:${a.subject ?? ""}`)) {
                    recordToolUse(winner.id, "create_email_draft", "already drafted this turn — skipped duplicate", true);
                    return JSON.stringify({ ok: true, deduped: true, message: "That draft was already created this turn." });
                  }
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
              lovableTools.get_calendar_events = tool({
                description:
                  "Read the user's Microsoft/Outlook calendar for a day or range and return the actual events. Use for 'what's on my calendar/schedule/agenda' or free/busy questions — reads REAL data, never answer calendar questions from memory or 'files'. Note: Microsoft/Outlook events only.",
                inputSchema: z.object({
                  start: z.string().optional(),
                  end: z.string().optional(),
                }),
                execute: async (args) => {
                  const a = args as Record<string, unknown>;
                  const tz = data.timeZone || "UTC";
                  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
                  const startRaw = typeof a.start === "string" && a.start.trim() ? a.start.trim() : todayStr;
                  const endRaw = typeof a.end === "string" && a.end.trim() ? a.end.trim() : startRaw;
                  const startDay = startRaw.slice(0, 10);
                  const endDay = endRaw.slice(0, 10);
                  const startISO = startRaw.length > 10 ? startRaw : `${startDay}T00:00:00`;
                  const endISO = endRaw.length > 10 ? endRaw : `${endDay}T23:59:59`;
                  const mailbox =
                    (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                    data.caller?.entra_email;
                  const { getGraphCalendarEvents } = await import("./email/graph-email.server");
                  const r = await getGraphCalendarEvents({ mailbox, startISO, endISO, timeZone: tz });
                  recordToolUse(
                    winner.id,
                    "get_calendar_events",
                    r.ok ? `${r.events?.length ?? 0} event(s)` : "calendar read failed",
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

          // Same cross-cutting safety as the OpenAI path: bound + catch every Lovable tool's
          // execute so a failing/hanging tool returns a result instead of sinking the turn.
          for (const [name, t] of Object.entries(lovableTools)) {
            const tt = t as { execute?: (args: unknown, opts: unknown) => unknown };
            const orig = tt.execute;
            if (typeof orig === "function") {
              tt.execute = (args: unknown, opts: unknown) =>
                runToolSafely(name, () => Promise.resolve(orig(args, opts)));
            }
          }

          const toolNames = Object.keys(lovableTools);
          toolTypes = toolNames;
          if (toolNames.length > 0) {
            recordToolUse(winner.id, "tool_catalog", `offered: ${toolNames.join(", ")}`, true);
          }

          const lovableToolChoice =
            forceReminder && lovableTools.schedule_reminder
              ? { type: "tool" as const, toolName: "schedule_reminder" }
              : forceTaskCreation && lovableTools.create_huddle_task
                ? { type: "tool" as const, toolName: "create_huddle_task" }
                : forceWebSearch && lovableTools.tavily_web_search
                  ? { type: "tool" as const, toolName: "tavily_web_search" }
                  : undefined;

          if (forceReminder && lovableTools.schedule_reminder) {
            recordToolUse(winner.id, "schedule_reminder", "offered (forced — reminder request)", true);
          } else if (forceTaskCreation && lovableTools.create_huddle_task) {
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

        if (!clean) return bundle({ kind: "skip" });

        // Persist prompt debug for this reply.
        prompts.push({
          agentId: winner.id,
          backend: usedBackend,
          model: usedModel,
          instructions: usedInstructions,
          fromSnapshot,
          toolTypes,
        });

        // PASS/self-censor + echo suppression + the reply push + mention-chain are
        // all applied by the driver during the ORDERED MERGE (see mergeAgentResult),
        // NOT here — so concurrent agents produce identical output to the sequential
        // engine. This task only surfaces the raw reply + the flags the merge needs.
        return bundle({
          kind: "reply",
          clean,
          isInterjector,
          perAgentFallbacks,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI error";
        const quota = isQuotaError(msg);
        const ev = recordFallback(
          "openai",
          `${winner.name}: model call failed — ${msg}`,
          quota ? QUOTA_OUTAGE_INLINE : `model call failed: ${msg.slice(0, 80)}`,
          winner.id,
          quota ? "critical" : "warn",
        );
        return bundle({
          kind: "hardReply",
          reply: {
            agentId: winner.id,
            text: quota
              ? `(couldn't respond — ${QUOTA_OUTAGE_INLINE})`
              : `(fallback: ${ev.inline}) couldn't reach the model — ${msg}`,
            fallbackNotes: [ev.inline],
          },
        });
      }
    };

    // ---- Merge a settled agent result into the shared turn state, in queue order.
    // The SOLE owner of replies/spoken/queue/handoffById and of the PASS + echo
    // suppression, so the transcript is byte-identical to the sequential engine no
    // matter what order the agents actually finished in. `waveIds` = the ids that
    // ran together this wave; a mid-reply @mention of a same-wave agent must NOT
    // re-enqueue it (it already ran once), mirroring the sequential queue.includes
    // guard for agents still pending in the queue.
    const mergeAgentResult = (
      nextId: AgentId,
      r: AgentTurnResult,
      waveIds: readonly AgentId[],
    ) => {
      const winner = AGENT_BY_ID[nextId]!;
      // Append-only buffers merge deterministically (queue order via call order).
      fallbacks.push(...r.fallbacks);
      toolUses.push(...r.toolUses);
      journeyTaskUpdates.push(...r.journeyTaskUpdates);
      suggestedTasks.push(...r.suggestedTasks);
      reasoningSummaries.push(...r.reasoning);
      prompts.push(...r.prompts);

      const outcome = r.outcome;
      if (outcome.kind === "skip") return; // produced nothing (no reply, not spoken)
      if (outcome.kind === "hardReply") {
        // Config/model-failure fallbacks: always emitted, no echo/PASS, no mentions.
        replies.push(outcome.reply);
        spoken.add(nextId);
        return;
      }

      // kind === "reply": an interjector that found nothing concrete stays silent.
      const clean = outcome.clean;
      const interjTrimmed = clean.trim();
      if (
        outcome.isInterjector &&
        (/^pass[.!]?$/i.test(interjTrimmed) || /\bPASS[.!]?$/.test(interjTrimmed))
      ) {
        spoken.add(nextId);
        return;
      }

      // Deterministic echo guard: drop a near-duplicate of a reply already merged
      // this turn. Checked against the growing `replies` during the ordered merge,
      // so it matches the sequential behavior exactly. Never fires on the first
      // speaker. Exempt during ceremonies (lane owners report distinct slices).
      if (!ceremonyActive && interjTrimmed && isEchoOfPrior(interjTrimmed, replies)) {
        recordFallback(
          "tool",
          `${winner.name}: near-duplicate of an earlier reply this turn — suppressed to avoid echo.`,
          "duplicate reply suppressed",
          winner.id,
        );
        spoken.add(nextId);
        return;
      }

      const finalText =
        outcome.perAgentFallbacks.length > 0
          ? `${clean}\n\n_(fallback: ${outcome.perAgentFallbacks.join("; ")})_`
          : clean;

      replies.push({
        agentId: nextId,
        text: finalText,
        fallbackNotes: outcome.perAgentFallbacks.length > 0 ? outcome.perAgentFallbacks : undefined,
      });
      spoken.add(nextId);

      // Mention-chaining is disabled during ceremonies (fixed participant list).
      const chained = ceremonyActive ? [] : parseMentions(clean, presentAgents);
      for (const id of chained) {
        if (
          id !== nextId &&
          !spoken.has(id) &&
          !queue.includes(id) &&
          !waveIds.includes(id) &&
          data.members.includes(id)
        ) {
          queue.push(id);
          // Hand off a structured ask so the mentioned agent addresses the actual request rather
          // than re-deriving it from raw context. Keep the last handoff if mentioned by several.
          handoffById.set(id, { fromName: winner.name, ask: clean.replace(/\s+/g, " ").trim().slice(0, 300) });
        }
      }

      // 1:1 owner follow-up (AC-4) — DETERMINISTIC back-channel, no @-parsing. In a DM, resolve the
      // owner of the USER's ask from data (capability triggers for exclusive tools, else the domain/theme
      // lane owner). If that owner isn't the addressed agent, enqueue a backend turn so they reply in
      // THEIR OWN DM — which fires the existing away-notification. Once per owner per turn; 1:1 only
      // (group turns bring the owner in via the normal re-queue above).
      if (data.scope !== "group") {
        const ownerId = capabilityOwnerFor(data.text)?.agent.id ?? laneOwnerFor(data.text, nextId)?.id ?? null;
        if (ownerId && ownerId !== nextId && !followupDelivered.has(ownerId)) {
          followupDelivered.add(ownerId);
          void deliverOwnerFollowup(ownerId, winner.name, data.text);
        }
      }
    };

    // The frozen anti-repetition anchor for the NEXT agent(s) to run: every reply
    // merged so far, in order. Recomputed once per wave and shared by all agents
    // in that wave (they do not see each other's replies).
    const buildPrior = () =>
      replies
        .map((rep) => `${AGENT_BY_ID[rep.agentId].name} just said: "${rep.text}"`)
        .join("\n");

    // Pop the next runnable agent, skipping ones that already spoke or aren't
    // members (mirrors the sequential loop's per-iteration skip checks).
    const shiftEligible = (): AgentId | null => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (spoken.has(id)) continue;
        if (!AGENT_BY_ID[id] || !data.members.includes(id)) continue;
        return id;
      }
      return null;
    };

    // Per-agent hard timeout. After parallelization a group turn's wall-time is
    // primary + max(wave agent); OpenAI per-call latency is high-variance, so one stalled agent can
    // still drag a wave to the deadline. Bound each agent by the time REMAINING to `deadlineMs` (the
    // 36s sync-path deadline OR the 30s per-chunk budget). NOTE: this races the response only; a
    // truly abandoned call's late tool side-effects aren't cancelled here (rare). In CHUNKED mode a
    // higher floor keeps a late-in-chunk agent from getting a near-zero bound that guarantees a
    // timeout-drop — the pre-wave budget gate re-queues agents there's no room for, so anything that
    // DOES start gets a workable slice. A per-agent timeout still bounds a single pathological agent.
    const runBounded = (id: AgentId, prior: string): Promise<AgentTurnResult> => {
      const floor = chunked ? 8_000 : 2_000;
      const remaining = Math.max(floor, deadlineMs - (Date.now() - turnStartMs));
      return Promise.race([
        runAgentTurn(id, prior),
        new Promise<AgentTurnResult>((resolve) =>
          setTimeout(() => {
            const nm = AGENT_BY_ID[id]?.name ?? id;
            resolve({
              fallbacks: [
                {
                  id: `fb-${Date.now()}-${id}-timeout`,
                  ts: Date.now(),
                  agentId: id,
                  subsystem: "tool",
                  reason: `${nm}: deferred to keep the turn under the response deadline.`,
                  inline: "response timed out — deferred",
                },
              ],
              toolUses: [],
              journeyTaskUpdates: [],
              suggestedTasks: [],
              reasoning: [],
              prompts: [],
              outcome: { kind: "skip" },
            });
          }, remaining),
        ),
      ]);
    };

    // Serialize the exact mid-turn position for a continuation chunk (Sets/Maps → arrays).
    const buildResumeState = (): TurnResumeState => ({
      decision: routed.decision,
      remainingQueue: [...queue],
      spoken: [...spoken],
      createdTaskTitles: [...createdTaskTitles],
      claimedActions: [...turnActionLedger],
      handoffById: [...handoffById.entries()],
      interjectors: [...interjectorSet],
      ceremonyActive,
      ceremonyDirectives: [...ceremonyDirectiveById.entries()],
      replyCap,
      replies,
      journeyTaskUpdates,
      suggestedTasks,
      toolUses,
      reasoning: reasoningSummaries,
      fallbacks,
      prompts,
    });

    const finalResult = () => ({
      decision: routed.decision,
      replies,
      fallbacks,
      prompts,
      journeyTaskUpdates,
      suggestedTasks,
      toolUses,
      reasoning: reasoningSummaries,
    });

    // Mid-chunk STREAM: push the replies produced so far to the durable store the instant a wave (or
    // a ceremony agent) lands, so the client's poll renders each reply as it arrives instead of the
    // whole chunk at once. Keeps status 'running' and does NOT bump the chunk counter (see
    // updateTurnReplies). No-op on the synchronous path.
    const streamChunk = async () => {
      if (!chunked || !turnId || !turnStore) return;
      try {
        await turnStore.updateTurnReplies(turnId, replies, buildResumeState());
      } catch (e) {
        console.error("[turn-stream] updateTurnReplies failed", e instanceof Error ? e.message : e);
      }
    };

    // True once THIS chunk has spent its time budget: stop STARTING new work (agents left in `queue`
    // are re-queued for the next chunk, never dropped). Only meaningful in chunked mode.
    const chunkBudgetHit = () => chunked && Date.now() - turnStartMs > CHUNK_BUDGET_MS;

    if (ceremonyActive) {
      // Ceremonies stay STRICTLY SEQUENTIAL: each participant (lane owners, then
      // the host/closer) speaks in turn seeing everything said before it.
      while (replies.length < replyCap) {
        // Chunked: once the budget is spent, stop and let the runner continue the ceremony next chunk
        // (participants stay in `queue`). The host-closes-last ordering is preserved because the queue
        // order is preserved across the boundary.
        if (chunkBudgetHit() && queue.length > 0) break;
        const nextId = shiftEligible();
        if (nextId == null) break;
        const r = await runBounded(nextId, buildPrior());
        mergeAgentResult(nextId, r, [nextId]);
        await streamChunk();
      }
    } else {
      // Normal group turn: the PRIMARY winner runs first (sequentially) so the
      // rest of the turn anti-repeats against a settled anchor; then the remaining
      // agents of each wave run CONCURRENTLY (~max(agent) latency instead of the
      // sum), each seeded with the SAME frozen prior. Waves repeat to drain the
      // mention-chain handoffs (each wave's @mentions enqueue the next wave).
      if (replies.length < replyCap) {
        const primaryId = shiftEligible();
        if (primaryId != null) {
          const r = await runBounded(primaryId, buildPrior());
          mergeAgentResult(primaryId, r, [primaryId]);
          await streamChunk();
        }
      }
      while (replies.length < replyCap && queue.length > 0) {
        const frozenPrior = buildPrior();
        if (Date.now() - turnStartMs > deadlineMs) {
          if (chunked) {
            // CHUNKED: budget spent — leave the rest on `queue` (persisted below) and continue next
            // chunk. Do NOT emit "deferred" fallbacks: nothing is dropped, only time-sliced.
            break;
          }
          // SYNC: past the turn deadline, defer the rest (unchanged behavior) instead of starting
          // another wave whose bounded timeouts would stack and breach the hosting ceiling.
          for (const id of queue) {
            const a = AGENT_BY_ID[id];
            if (a) recordFallback("tool", `${a.name}: deferred — turn deadline reached before it could run.`, "deferred (deadline)", a.id);
          }
          break;
        }
        // Drain the current queue into one wave, bounded by remaining reply slots
        // so we never run an agent whose reply couldn't be shown (which would
        // execute tool side-effects the sequential engine never would). Overflow
        // simply rolls into the next wave.
        const wave: AgentId[] = [];
        const slots = replyCap - replies.length;
        while (wave.length < slots) {
          const id = shiftEligible();
          if (id == null) break;
          wave.push(id);
        }
        if (wave.length === 0) break;
        const results = await Promise.all(wave.map((id) => runBounded(id, frozenPrior)));
        for (let i = 0; i < wave.length; i++) {
          mergeAgentResult(wave[i], results[i], wave);
        }
        await streamChunk();
      }
    }

    // ---- Terminal / continuation persistence (chunked mode only) ----
    if (chunked && turnId && turnStore) {
      const remainingEligible = queue.filter(
        (id) => !spoken.has(id) && AGENT_BY_ID[id] && data.members.includes(id),
      );
      // Continue only if there is real work left AND we haven't hit the runaway cap AND the reply cap
      // still has room. Otherwise finalize DONE with whatever we have.
      const hasMore = replies.length < replyCap && remainingEligible.length > 0 && !atChunkCap;
      if (hasMore) {
        try {
          await turnStore.saveTurnChunk(turnId, replies, buildResumeState(), false);
        } catch (e) {
          console.error("[turn-chunk] partial save failed", e instanceof Error ? e.message : e);
        }
        return { ...finalResult(), partial: true };
      }
      try {
        await turnStore.saveTurnChunk(turnId, replies, null, true, finalResult());
      } catch (e) {
        console.error("[turn-chunk] done save failed", e instanceof Error ? e.message : e);
      }
      return { ...finalResult(), partial: false };
    }

    return finalResult();
}

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => runHuddleTurn(data));

// ---- Durable, device-independent turns ------------------------------------------------------
// A chat turn no longer depends on the phone holding a long fetch open. The client PERSISTS the
// turn (keyed by a client-generated turnId) and runs it best-effort in this request; the result is
// stored the instant it's ready, so backgrounding the app (screen off, app switch) can't lose it —
// the delivery loop re-reads it on reconnect. A journey pg_cron heartbeat drains any turn left
// `queued` or stale-`running` (the case where this phone-tied request was killed mid-flight), so a
// turn always completes and a push notification fires even while the user is fully away.

const EnqueueTurnInput = Input.extend({
  // Client-generated idempotency key (e.g. the user message id). Re-sending the same turnId never
  // double-runs — the row is INSERT ... ON CONFLICT DO NOTHING and execution is claim-locked.
  turnId: z.string().min(6).max(80),
});

type HuddleTurnResult = Awaited<ReturnType<typeof runHuddleTurn>>;

/**
 * Run a claimed turn to completion, persist the result, and (best-effort) push-notify the user. The
 * service worker decides whether to actually surface the notification (suppressed if a tab is
 * focused). Shared by the client fast-path and the cron backstop so both behave identically.
 */
// Self-kick the runner for the NEXT chunk of a partial turn — fast continuation so the user doesn't
// wait for the 1-min cron. Fire-and-forget POST to this app's own /api/public/run-turn (mirrors
// journey's drain edge fn), authed with the shared JOURNEY_PROXY_TOKEN (NO new secret). The cron
// heartbeat remains the guaranteed backstop if this request is frozen before the fetch lands. Base
// URL: HUDDLE_APP_URL app setting, else the Azure runtime's WEBSITE_HOSTNAME.
async function kickNextChunk(turnId: string): Promise<void> {
  const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  if (!token) return;
  const rawBase =
    (process.env.HUDDLE_APP_URL ?? "").trim() ||
    (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : "");
  const base = rawBase.replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/api/public/run-turn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": token },
      body: JSON.stringify({ turnId }),
    });
  } catch {
    /* fire-and-forget: the cron drain backstops a lost kick within a minute */
  }
}

async function executeClaimedTurn(record: {
  id: string;
  user_email: string | null;
  payload: Record<string, unknown>;
  progress?: unknown;
}): Promise<HuddleTurnResult | null> {
  const { failTurn } = await import("./tasks/turns.server");
  try {
    const data = Input.parse(record.payload);
    // DURABLE/CHUNKED run: the driver streams replies and persists the terminal 'done'/'partial' row
    // itself (saveTurnChunk), so we do NOT completeTurn here. A resumed chunk rebuilds its mid-turn
    // state from record.progress; a fresh durable run passes resume=undefined.
    const result = await runHuddleTurn(data, {
      turnId: record.id,
      resume: record.progress ?? undefined,
    });
    // More agents remain (budget-sliced): kick the next chunk now and defer push until the turn is
    // fully done (a single "X replied" notification at the end, not one per chunk).
    if ((result as { partial?: boolean }).partial === true) {
      void kickNextChunk(record.id);
      return result;
    }
    // Urgency-aware delivery (ACT-5 Phase B triage). Every finished turn posts its reply in-app; whether
    // it also fires a phone PUSH depends on the enqueuer's declared intent (`payload.notify`):
    //   "push"   (or unset) → buzz now  — interactive replies + genuine blockers/decisions.
    //   "batch"           → NO push    — routine autonomous results; they wait in-app for the standup digest.
    //   "silent"          → NO push    — never nudge.
    // This is why routine research results should NOT buzz the phone: the autonomy engine tags them
    // "batch". A real blocker the agent surfaces is tagged "push". The channel choice lives with the
    // side that KNOWS the intent (the enqueuer), not a fragile keyword classifier here.
    const notifyLevel = String((record.payload as { notify?: string })?.notify ?? "push");
    const wantsPush = notifyLevel !== "batch" && notifyLevel !== "silent";
    const lead = result.replies?.[0];
    if (lead && wantsPush) {
      const name = AGENT_BY_ID[lead.agentId]?.name ?? "Huddle";
      const title = `${name} replied`;
      const body = String(lead.text).replace(/\s+/g, " ").slice(0, 140);
      // Primary away-delivery: piggyback journey's push (web-push + FCM/Android bridge), the SAME
      // reliable path reminders/alarms use to reach the phone. No separate Huddle VAPID keys needed;
      // this reuses journey's existing notification infra (channel `messages` = heads-up reply).
      if (record.user_email) {
        try {
          const { invokeJourneyTool } = await import("./journey/proxy.functions");
          // deepLink targets the exact 1:1/huddle so tapping the phone notification opens that channel.
          // journey's sendPushNow spreads args.data into the push → send-push-notification's
          // fcmData.deepLink; the Android bridge loads baseUrl + deepLink, so in the Huddle app this
          // opens `?huddle=<id>` (the client reads it and switches to that huddle). Harmless elsewhere.
          const huddleId = String((record.payload as { huddleId?: string })?.huddleId ?? "");
          await invokeJourneyTool({
            toolName: "send_push",
            args: {
              title,
              body,
              channel: "messages",
              // Source-app tag: journey delivers this ONLY to the standalone Huddle bridge app's device
              // token (endpoint `fcm:app:huddle:%`), so an agent reply doesn't also duplicate onto
              // journey's web + bridge notifications.
              app: "huddle",
              data: {
                ...(huddleId
                  ? { deepLink: `/?huddle=${huddleId}`, source: "huddle-message", huddleId }
                  : {}),
                // UNIQUE per turn. The Android bridge identifies a notification by its `tag`
                // (`notify(tag, 0, …)`) and journey defaults an untagged push to the constant `'fcm'`,
                // so every reply would REPLACE the previous one — you'd see only the latest, not each
                // message as it was posted. A per-turn tag makes each reply its own shade entry, arriving
                // one at a time. `notificationId` tags web-push the same way.
                notificationId: record.id,
                tag: record.id,
              },
            },
            caller: { entra_email: record.user_email },
            context: { source: "huddle" },
          });
        } catch {
          /* journey push best-effort */
        }
      }
      // Optional extra: Huddle's own Web Push for pure-browser subscribers (no-op unless Huddle VAPID
      // keys are set). Harmless to keep; journey's path above is what covers the phone.
      try {
        const { sendPushToUser } = await import("./push/push.server");
        await sendPushToUser(record.user_email, {
          title,
          body,
          url: "/",
          tag: `huddle-${data.huddleId}`,
        });
      } catch {
        /* push is best-effort */
      }
    }
    return result;
  } catch (err) {
    await failTurn(record.id, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Client entrypoint. Persist the turn, then run it in THIS request (fast path). If this request is
 * killed by the app backgrounding before it stores, the turn is left claimable and the cron
 * heartbeat finishes it — either way the result lands in the durable store and is delivered on
 * return. Returns the result when the fast path completes; the client also polls `getTurnUpdates`.
 */
export const enqueueHuddleTurn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => EnqueueTurnInput.parse(raw))
  .handler(async ({ data }) => {
    const { turnId, ...turnData } = data;
    // Resolve the sign-in email (possibly an alias) to the canonical journey email for push targeting.
    let email: string | null = null;
    try {
      const { resolveTaskEmail } = await import("./journey/identity");
      email = (await resolveTaskEmail(data.caller)) ?? data.caller?.entra_email ?? null;
    } catch {
      email = data.caller?.entra_email ?? null;
    }
    const { enqueueTurn, claimTurn, getTurn } = await import("./tasks/turns.server");
    await enqueueTurn(turnId, data.huddleId, email, turnData);
    // Claim + run right now (fast path). If another runner (cron) already grabbed it, fall through
    // to reporting status so we never double-run (the client then polls getTurnUpdates for the result).
    const claimed = await claimTurn(turnId);
    if (claimed) {
      const result = await executeClaimedTurn(claimed);
      if (result) {
        // The first chunk ran here. If more agents remain it's 'partial': return the replies produced
        // so far AND status 'partial' so the client renders them immediately and keeps polling for the
        // rest (streamed as later chunks land). Otherwise it's fully 'done'.
        const partial = (result as { partial?: boolean }).partial === true;
        return { turnId, status: (partial ? "partial" : "done") as string, result, error: null as string | null };
      }
      const rec = await getTurn(turnId);
      return { turnId, status: (rec?.status ?? "error") as string, result: null as HuddleTurnResult | null, error: rec?.error ?? null };
    }
    const rec = await getTurn(turnId);
    return { turnId, status: (rec?.status ?? "queued") as string, result: null as HuddleTurnResult | null, error: rec?.error ?? null };
  });

/** The public VAPID key the browser needs to create a push subscription (null if push isn't set up). */
export const getPushConfig = createServerFn({ method: "GET" }).handler(async () => {
  const { vapidPublicKey } = await import("./push/push.server");
  return { vapidPublicKey: vapidPublicKey() };
});

/** Deliver finished turns to a client that (re)connected — the backgrounding-safe read path. */
const TurnUpdatesInput = z.object({
  huddleId: z.string(),
  sinceMs: z.number().optional(),
});
export const getTurnUpdates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => TurnUpdatesInput.parse(raw))
  .handler(async ({ data }) => {
    const { getTurnsSince } = await import("./tasks/turns.server");
    const rows = await getTurnsSince(data.huddleId, data.sinceMs ?? 0);
    // Trim to a serializable DTO (drop the raw payload; type result like the live turn result).
    // `replies` + `seq` carry the incrementally-streamed per-agent replies for in-flight
    // ('partial'/'running') turns so the client renders them as they land; `result` is the full
    // payload set once the turn is 'done'. The client keys agent messages on reply index (idempotent),
    // so a partial turn re-appearing with more replies just appends the new ones.
    const turns = rows.map((t) => ({
      id: t.id,
      status: t.status as string,
      error: t.error,
      updated_ms: t.updated_ms,
      seq: t.seq,
      replies: (t.replies ?? []) as { agentId: AgentId; text: string }[],
      result: (t.result ?? null) as HuddleTurnResult | null,
    }));
    return { turns };
  });

/** Reminders that have fired for a huddle since `sinceMs` — the client renders each as an agent message. */
export const getReminderDeliveries = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => TurnUpdatesInput.parse(raw))
  .handler(async ({ data }) => {
    const { getFiredRemindersSince } = await import("./tasks/turns.server");
    const rows = await getFiredRemindersSince(data.huddleId, data.sinceMs ?? 0);
    const reminders = rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      text: r.text,
      kind: r.kind,
      firedMs: r.fired_ms ?? 0,
    }));
    return { reminders };
  });

/** GLOBAL durable-turn back-fill: every FINISHED reply for this user across ALL huddles since `sinceMs`.
 *  The per-huddle getTurnUpdates poll is gated on a locally-submitted turn, so an autonomous reply
 *  (grooming/blocker/standup/owner-followup) that completes while the user is away — or in a huddle they
 *  aren't viewing — never reaches the transcript even though its push fired. The client polls this on
 *  load/focus and merges each reply into its OWN huddle (returned as `huddleId`), so the message the
 *  notification announced is actually there. Reply id on the client mirrors the live poll
 *  (`a-<turnId>-<i>`) so live-poll / interactive / back-fill collapse to one message. */
const AllTurnUpdatesInput = z.object({
  caller: z
    .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
    .optional(),
  sinceMs: z.number().optional(),
});
export const getAllTurnUpdates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => AllTurnUpdatesInput.parse(raw))
  .handler(async ({ data }) => {
    type BackfillTurn = {
      id: string;
      huddleId: string;
      updated_ms: number;
      replies: { agentId: AgentId; text: string }[];
    };
    const empty: BackfillTurn[] = [];
    if (!data.caller?.entra_email) return { turns: empty };
    let email: string | null = null;
    try {
      const { resolveTaskEmail } = await import("./journey/identity");
      email = (await resolveTaskEmail(data.caller)) ?? data.caller.entra_email ?? null;
    } catch {
      email = data.caller.entra_email ?? null;
    }
    if (!email) return { turns: empty };
    const { getUserTurnsSince } = await import("./tasks/turns.server");
    const rows = await getUserTurnsSince(email, data.sinceMs ?? 0);
    const turns: BackfillTurn[] = rows.map((t) => ({
      id: t.id,
      huddleId: t.huddle_id,
      updated_ms: t.updated_ms,
      // A 'done' turn's authoritative replies live in `result.replies`; fall back to the streamed column.
      replies: (((t.result as { replies?: unknown } | null)?.replies ?? t.replies ?? []) as {
        agentId: AgentId;
        text: string;
      }[]),
    }));
    return { turns };
  });

/** Save/refresh a Web Push subscription for the signed-in user (for notify-while-away). */
const PushSubInput = z.object({
  caller: z.object({
    entra_object_id: z.string().optional(),
    entra_email: z.string().optional(),
  }).optional(),
  subscription: z.object({
    endpoint: z.string(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
});
export const registerPushSubscription = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PushSubInput.parse(raw))
  .handler(async ({ data }) => {
    let email: string | null = null;
    try {
      const { resolveTaskEmail } = await import("./journey/identity");
      email = (await resolveTaskEmail(data.caller)) ?? data.caller?.entra_email ?? null;
    } catch {
      email = data.caller?.entra_email ?? null;
    }
    if (!email) return { ok: false as const, error: "no_identity" };
    const { savePushSubscription } = await import("./tasks/turns.server");
    await savePushSubscription(email, {
      endpoint: data.subscription.endpoint,
      p256dh: data.subscription.keys.p256dh,
      auth: data.subscription.keys.auth,
    });
    return { ok: true as const };
  });

// Register the STANDALONE Huddle bridge app's FCM device token so journey's send_push can reach it.
// The token (from window.AndroidBridge.getFcmToken()) is routed through the huddle-proxy, which resolves
// the caller to a journey user and calls execute-tool `register_push_token` — so the Huddle app's token
// joins the SAME push_subscriptions store journey already delivers to. Reuse, not a new sender: this is
// what lets a Huddle-agent push land on the Huddle app (and deep-link into the right channel).
const BridgeFcmInput = z.object({
  caller: z
    .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
    .optional(),
  token: z.string().min(1),
});
export const registerBridgeFcmToken = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => BridgeFcmInput.parse(raw))
  .handler(async ({ data }) => {
    try {
      const { invokeJourneyTool } = await import("./journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "register_push_token",
        // `app:"huddle"` namespaces the endpoint as `fcm:app:huddle:<token>` so journey can target this
        // app's device exclusively (and exclude it from journey-native pushes).
        args: { fcm_token: data.token, app: "huddle" },
        caller: data.caller ?? {},
        context: { source: "huddle" },
      });
      return { ok: !!r.ok, error: r.ok ? undefined : String(r.error ?? "register_failed") };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

/**
 * Backstop executor used by the run-turn route (cron heartbeat). Drains up to `max` queued or
 * stale-running turns, running each to completion. Returns how many it ran. This is the guaranteed,
 * device-independent path: journey's always-on pg_cron POSTs here every minute.
 */
export async function drainQueuedTurns(max = 5): Promise<number> {
  const { claimNextQueued } = await import("./tasks/turns.server");
  let ran = 0;
  for (let i = 0; i < max; i++) {
    const claimed = await claimNextQueued();
    if (!claimed) break;
    await executeClaimedTurn(claimed);
    ran++;
  }
  return ran;
}

/** Run one specific turn by id (targeted kick). Returns true if it claimed and ran it. */
export async function runTurnById(turnId: string): Promise<boolean> {
  const { claimTurn } = await import("./tasks/turns.server");
  const claimed = await claimTurn(turnId);
  if (!claimed) return false;
  await executeClaimedTurn(claimed);
  return true;
}

// Recent persisted ceremony runs for the signed-in user — powers "review what happened later"
// (e.g. an auto-run that fired while you were away) in the virtual-meeting view.
const CeremonyRunsInput = z.object({
  caller: z.object({ entra_email: z.string().optional() }).optional(),
  limit: z.number().optional(),
});
export const listCeremonyRuns = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => CeremonyRunsInput.parse(raw))
  .handler(async ({ data }) => {
    const email = data.caller?.entra_email?.trim();
    let runs: import("./tasks/tasks.server").CeremonyRunRow[] = [];
    if (email) {
      try {
        const { getCeremonyRuns } = await import("./tasks/tasks.server");
        runs = await getCeremonyRuns(email, data.limit ?? 20);
      } catch (err) {
        console.error("[listCeremonyRuns] failed", err instanceof Error ? err.message : err);
      }
    }
    return { runs };
  });
