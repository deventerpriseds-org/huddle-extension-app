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
import { getAssistantSnapshot } from "../openai-assistants.server";
import {
  fetchJourneyToolDefinitions,
  toResponsesTool,
  invokeJourneyTool,
} from "../journey/proxy.functions";
import { PRIORITIZE_TOOL } from "../tasks/tools";
import { SCHEDULE_REMINDER_TOOL } from "../tasks/reminders";
import { GROOM_BACKLOG_TOOL } from "../tasks/groom";
import { TAVILY_WEB_SEARCH_TOOL, tavilySearch, type TavilySearchArgs } from "../tavily-search.functions";
// SINGLE SOURCE — the same get_calendar_events schema the text turn engine uses (no voice-local copy).
import { GET_CALENDAR_EVENTS_TOOL } from "../calendar/tools";

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
  "lists, no emoji — this is read aloud. Ask one question at a time. When you need real data you MUST " +
  "CALL a tool and answer from its result — never answer from memory or say the data isn't available. " +
  "For the user's SCHEDULE, calendar, agenda, day, tasks, priorities, backlog, meetings, or 'what's on " +
  "my plate/day/calendar', ALWAYS call `prioritize` (use view 'scheduled' for what's on today's " +
  "schedule) — that is the user's combined nightly schedule (tasks + external calendar already merged), " +
  "the source of truth. Use `get_calendar_events` ONLY if the user explicitly says 'external calendar' " +
  "or 'Outlook calendar' (rare). Don't narrate that you're using a tool.";

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

// The app's function-tool schemas are shaped for the Responses/Chat APIs and carry fields the Realtime
// GA `/v1/realtime/client_secrets` endpoint REJECTS — notably `strict` (verified live: a `strict` on a
// session tool 400s the whole mint with "Unknown parameter: 'session.tools[0].strict'", so the speaking
// session never connects for ANY agent). Whitelist ONLY the fields Realtime accepts for a function tool;
// pass non-function tools (file_search) through untouched.
function toRealtimeTool(t: unknown): unknown {
  const rec = t as { type?: string; name?: string; description?: string; parameters?: unknown };
  if (rec?.type !== "function") return t; // file_search etc. — leave as-is
  return { type: "function", name: rec.name, description: rec.description, parameters: rec.parameters };
}

/** Governed tool schemas for the realtime session — mirrors the text path's mergedTools (minus the
 *  turn-scoped Huddle-native create tools, see file note), gated by the same ownership data, and
 *  SANITIZED to the Realtime-accepted shape (drops `strict`/Responses-only fields). */
export async function buildRealtimeToolset(
  agentId: AgentId,
  opts: { webSearch?: boolean; journey?: boolean } = {},
): Promise<{ tools: unknown[]; journeyNames: Set<string> }> {
  const agent = AGENT_BY_ID[agentId];
  const raw: unknown[] = [PRIORITIZE_TOOL, SCHEDULE_REMINDER_TOOL, GET_CALENDAR_EVENTS_TOOL];

  if (opts.webSearch !== false) raw.push(TAVILY_WEB_SEARCH_TOOL);
  if (agentOwnsCapability(agent, "backlog-grooming")) raw.push(GROOM_BACKLOG_TOOL);

  // NOTE: file_search (snapshot knowledge bases) is deliberately OMITTED — the Realtime GA
  // client_secrets endpoint only accepts tool types 'function' and 'mcp' and 400s on 'file_search',
  // which would break the whole speaking-session mint. KBs stay a text-path capability.

  // Journey catalog (calendar, schedule, tasks, priorities, push, …) — the bulk of "same brain".
  const journeyNames = new Set<string>();
  if (opts.journey !== false) {
    try {
      const defs = await fetchJourneyToolDefinitions();
      for (const d of defs) {
        journeyNames.add(d.name);
        raw.push(toResponsesTool(d));
      }
    } catch {
      // Journey catalog unavailable — voice still works with the native tools above.
    }
  }
  return { tools: raw.map(toRealtimeTool), journeyNames };
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
  const NATIVE = new Set([
    "prioritize",
    "schedule_reminder",
    "groom_backlog",
    "tavily_web_search",
    "get_calendar_events",
  ]);
  try {
    if (name === "get_calendar_events") {
      const { resolveTaskEmail } = await import("../journey/identity");
      const mailbox = (await resolveTaskEmail(ctx.caller)) ?? ctx.caller?.entra_email;
      const tz = ctx.timeZone || "UTC";
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
      const startRaw = typeof args.start === "string" && args.start.trim() ? args.start.trim() : todayStr;
      const endRaw = typeof args.end === "string" && args.end.trim() ? args.end.trim() : startRaw;
      const startISO = startRaw.length > 10 ? startRaw : `${startRaw.slice(0, 10)}T00:00:00`;
      const endISO = endRaw.length > 10 ? endRaw : `${endRaw.slice(0, 10)}T23:59:59`;
      const { getGraphCalendarEvents } = await import("../email/graph-email.server");
      const r = await getGraphCalendarEvents({ mailbox, startISO, endISO, timeZone: tz });
      return done(JSON.stringify(r));
    }
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
