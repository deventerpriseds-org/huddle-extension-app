// Approach A (OpenAI Realtime speaks directly) — server-side SAME-BRAIN assembly + DIRECT tool executor.
//
// Two jobs, both reused by the realtime session mint (getRealtimeSession):
//  1) assembleRealtimeInstructions(agentId, …): the agent's snapshot instructions + auto-retrieved RAG
//     memory + a voice house-style — the SAME brain the text turn uses (snapshot + memory), tuned for
//     spoken output. (Text chat's HOUSE_STYLE governs written form; voice needs short spoken turns.)
//  2) buildRealtimeToolset / executeRealtimeTool: the governed tool schemas for an agent + a DIRECT,
//     ONE-HOP in-process executor. Per the user's guidance, this does NOT copy journey's slow
//     `execute-tool` edge-function hop — every tool runs via the SAME importable dispatcher the text
//     turn calls (dispatchPrioritize / dispatchScheduleReminder / dispatchGroomBacklog / tavilySearch /
//     invokeJourneyTool). Only tools that inherently proxy to journey carry journey's own latency.
//
// Governance is data-driven (agents.ts capabilities via lib/capabilities.ts): grooming only for its
// owner, exactly as the text path gates it — so an ownership rotation propagates here for free.
//
// NOTE (v1 scope): the Huddle-native create_huddle_task / create_artifact executors are TURN-SCOPED
// inside runAgentTurn (they render UI board/artifact cards via per-turn state), so they are NOT wired
// into this v1 voice executor — journey's own task tools (from the journey catalog) cover task ops.
// Extracting those turn-scoped executors for full parity is the documented next layer.

import type { AgentId } from "../../data/agents";
import { AGENT_BY_ID } from "../../data/agents";
import { agentOwnsCapability } from "../capabilities";
import { getAssistantSnapshot, snapshotResponsesTools } from "../openai-assistants.server";
import {
  fetchJourneyToolDefinitions,
  toResponsesTool,
  invokeJourneyTool,
} from "../journey/proxy.functions";
import { PRIORITIZE_TOOL } from "../tasks/tools";
import { SCHEDULE_REMINDER_TOOL } from "../tasks/reminders";
import { GROOM_BACKLOG_TOOL } from "../tasks/groom";
import { TAVILY_WEB_SEARCH_TOOL, tavilySearch, type TavilySearchArgs } from "../tavily-search.functions";

export interface RealtimeCaller {
  entra_object_id?: string;
  entra_email?: string;
}

export interface RealtimeToolContext {
  agentId: AgentId;
  caller: RealtimeCaller;
  huddleId: string;
  timeZone?: string;
}

const VOICE_HOUSE_STYLE =
  "\n\nYou are on a live VOICE call. Speak naturally in 1–3 short spoken sentences. No markdown, no " +
  "lists, no emoji — this is read aloud. Ask one question at a time. When you need real data (the " +
  "user's schedule, tasks, priorities, or a web fact) CALL the appropriate tool, then say the result " +
  "in one short sentence. Don't narrate that you're using a tool.";

/** Same-brain instructions for the realtime session: snapshot + auto-retrieved memory + voice style. */
export async function assembleRealtimeInstructions(
  agentId: AgentId,
  opts: { memoryQuery?: string } = {},
): Promise<string> {
  const agent = AGENT_BY_ID[agentId];
  const snapshot = getAssistantSnapshot(agentId);
  const base = (snapshot?.instructions || agent?.systemPrompt || "").trim();

  let memoryBlock = "";
  const q = opts.memoryQuery?.trim();
  if (q) {
    try {
      const { azurePgStore } = await import("../rag/azure-pg.server");
      const hits = await azurePgStore.searchChunks({ query: q, k: 5, mode: "shared" });
      const snippets = (hits ?? [])
        .map((h) => (h as { text?: string }).text)
        .filter((t): t is string => !!t)
        .slice(0, 5);
      if (snippets.length > 0) {
        memoryBlock =
          "\n\nRELEVANT MEMORY (recent context across the user's conversations):\n" +
          snippets.map((s) => `- ${s}`).join("\n");
      }
    } catch {
      // Memory is best-effort — never block a voice reply on retrieval.
    }
  }

  return base + memoryBlock + VOICE_HOUSE_STYLE;
}

/** Governed tool schemas for the realtime session — mirrors the text path's mergedTools (minus the
 *  turn-scoped Huddle-native create tools, see file note), gated by the same ownership data. */
export async function buildRealtimeToolset(
  agentId: AgentId,
  opts: { webSearch?: boolean; journey?: boolean } = {},
): Promise<{ tools: unknown[]; journeyNames: Set<string> }> {
  const agent = AGENT_BY_ID[agentId];
  const tools: unknown[] = [PRIORITIZE_TOOL, SCHEDULE_REMINDER_TOOL];

  if (opts.webSearch !== false) tools.push(TAVILY_WEB_SEARCH_TOOL);
  if (agentOwnsCapability(agent, "backlog-grooming")) tools.push(GROOM_BACKLOG_TOOL);

  // Non-function snapshot tools (file_search knowledge bases) if the agent has any.
  const snapshot = getAssistantSnapshot(agentId);
  const snapshotTools = snapshotResponsesTools(snapshot).filter(
    (t) => (t as { type?: string })?.type !== "function",
  );
  tools.push(...snapshotTools);

  // Journey catalog (calendar, schedule, tasks, priorities, push, …) — the bulk of "same brain".
  const journeyNames = new Set<string>();
  if (opts.journey !== false) {
    try {
      const defs = await fetchJourneyToolDefinitions();
      for (const d of defs) {
        journeyNames.add(d.name);
        tools.push(toResponsesTool(d));
      }
    } catch {
      // Journey catalog unavailable — voice still works with the native tools above.
    }
  }
  return { tools, journeyNames };
}

/** DIRECT, one-hop executor for a realtime tool call. Returns the tool output string + elapsed ms
 *  (instrumented so "too slow" is measured). Reuses the SAME dispatchers as the text turn. */
export async function executeRealtimeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: RealtimeToolContext,
): Promise<{ output: string; ms: number }> {
  const t0 = Date.now();
  const done = (output: string) => ({ output, ms: Date.now() - t0 });
  const NATIVE = new Set(["prioritize", "schedule_reminder", "groom_backlog", "tavily_web_search"]);
  try {
    if (name === "prioritize") {
      const { dispatchPrioritize } = await import("../tasks/tools");
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = (await resolveTaskEmail(ctx.caller)) ?? ctx.caller?.entra_email;
      return done(await dispatchPrioritize(email, args));
    }
    if (name === "schedule_reminder") {
      const { dispatchScheduleReminder } = await import("../tasks/reminders");
      return done(
        await dispatchScheduleReminder(ctx.caller, args, ctx.huddleId, ctx.agentId, ctx.timeZone),
      );
    }
    if (name === "groom_backlog") {
      const { dispatchGroomBacklog } = await import("../tasks/groom");
      return done(await dispatchGroomBacklog(ctx.caller, args));
    }
    if (name === "tavily_web_search") {
      const r = await tavilySearch(args as unknown as TavilySearchArgs);
      return done(JSON.stringify(r));
    }
    // Anything not native → route to the journey catalog directly (no per-call catalog fetch → lower
    // latency). An unknown/unsupported name comes back as a journey error, surfaced to the model.
    if (!NATIVE.has(name)) {
      const r = await invokeJourneyTool({
        toolName: name,
        args,
        caller: ctx.caller ?? {},
        context: { source: "huddle", huddleId: ctx.huddleId, agentId: ctx.agentId },
      });
      return done(r.output);
    }
    return done(JSON.stringify({ error: `Tool not available on the voice path: ${name}` }));
  } catch (err) {
    return done(JSON.stringify({ error: err instanceof Error ? err.message : String(err), tool: name }));
  }
}
