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
// NOTE (v1 scope, NOW CLOSED — kept for the history): create_huddle_task / create_artifact were once
// text-only because their executors are TURN-SCOPED inside runAgentTurn (they render UI board/artifact
// cards via per-turn state). create_artifact was retro-fitted first (ACT-huddle-40); create_huddle_task,
// create_huddle_tasks and confirm_task_intent followed after BATCH-3-RESULTS.md measured the gap. The
// turn-scoped half (board cards, recordToolUse breadcrumbs) genuinely does not exist on a voice call;
// the DURABLE half was extracted to tasks/create-task-core.ts and tasks/confirm-ask.functions.ts
// (confirmTaskFromProposal) and is now CALLED here, not reimplemented. See
// docs/cross-app-agent/FIX-voice-capability-gaps.md (nexus-hub) for which tools stay text-only and why.
//
// THE ASYMMETRY THAT BITES: executeRealtimeTool dispatches on a local NATIVE set, and anything NOT in
// that set falls through to invokeJourneyTool. A Huddle-native tool added to buildRealtimeToolset but
// NOT to NATIVE is silently proxied to journey and fails there. Both halves, every time.

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
// SINGLE SOURCE — the same calendar schemas the text turn engine uses (no voice-local copy).
// get_calendar_events = alias → combined schedule; get_external_calendar_events = raw Outlook (Graph).
import { GET_CALENDAR_EVENTS_TOOL, GET_EXTERNAL_CALENDAR_EVENTS_TOOL } from "../calendar/tools";
// SHARED with the text turn engine — the capability meta-task guard, cross-turn dedup, journey date
// normalization and the honest outcome note. NOT a voice copy: huddle.functions.ts's two task-create
// closures call these same functions, so the two surfaces cannot drift.
import {
  loadOpenTaskTitles,
  normalizeJourneyDate,
  normalizeTaskTitle,
  screenCapabilityMetaTask,
  splitTaskEntries,
  summarizeQuickCreateOutcome,
} from "../tasks/create-task-core";

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
  "my plate/day/calendar', ALWAYS call `schedule_and_priorities` (use view 'scheduled' for today's " +
  "schedule) — that is the user's combined nightly schedule (tasks + external calendar already merged), " +
  "the source of truth. Use `get_external_calendar_events` ONLY if the user explicitly says 'external calendar' " +
  "or 'Outlook calendar' (rare). Don't narrate that you're using a tool." +
  " To EMAIL something to the user or anyone, CALL `send_email` (or `create_email_draft` to prepare one " +
  "without sending) — never a message, push, or chat tool for an email request. Only say an email was " +
  "actually sent if `send_email` returned success; if you only drafted it, say exactly that." +
  " To PRODUCE a document, memo, plan, budget, brief, or file for the user, CALL `create_artifact` with the " +
  "FULL content — do NOT just say you'll 'generate an MD file' or 'put it in a document'; actually call the " +
  "tool so it becomes a reviewable file. Only say you saved a document if `create_artifact` returned success.";

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
  const raw: unknown[] = [PRIORITIZE_TOOL, SCHEDULE_REMINDER_TOOL, GET_CALENDAR_EVENTS_TOOL, GET_EXTERNAL_CALENDAR_EVENTS_TOOL];

  if (opts.webSearch !== false) raw.push(TAVILY_WEB_SEARCH_TOOL);
  if (agentOwnsCapability(agent, "backlog-grooming")) raw.push(GROOM_BACKLOG_TOOL);

  // Native task capture — the voice agent was MISSING create_huddle_task/create_huddle_tasks, so a
  // spoken "add that to my board" could not create a Huddle card; it reached only journey's raw
  // quick_create_task from the catalog, which skips Huddle's exclusive-capability meta-task guard, its
  // cross-turn dedup, and the honest scheduled/deferred outcome note. Same guards, same journey tools,
  // same shared helpers as the text path (tasks/create-task-core.ts) — see the file header.
  raw.push(
    {
      type: "function",
      name: "create_huddle_task",
      description:
        "Create ONE task when the user asks to add, log, track, capture or put something on their " +
        "board. It lands on the Huddle board and their journey board in one call. For MORE THAN ONE " +
        "task in a single request use create_huddle_tasks instead. Report what the result actually " +
        "says — it tells you whether it was scheduled, is unscheduled, or was skipped as a duplicate.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Short task title. Keep any time/date phrase inline in the title (e.g. \"Renew passport by Friday\") — it is parsed server-side." },
          date: {
            type: "string",
            description:
              "Optional, ONLY for exactly 'today', 'tomorrow', or an explicit YYYY-MM-DD you are certain of. For any other date the user said (a weekday name, 'next Tuesday'), leave this unset and keep the phrase in the title instead.",
          },
        },
        required: ["title"],
      },
    },
    {
      type: "function",
      name: "create_huddle_tasks",
      description:
        "Create SEVERAL tasks at once — use this, NOT repeated create_huddle_task calls, whenever the " +
        "user rattles off more than one thing (\"gym at nine, lunch at twelve, call mom at five\"). One " +
        "call creates and co-schedules all of them. The result gives the EXACT number created plus " +
        "anything skipped as a duplicate — state that number, never assume they all landed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: {
            type: "array",
            items: { type: "string" },
            description:
              'The tasks, one string each. Keep any time/date phrase inline in the string ("Gym at 9am", "Call mom tomorrow") — it is parsed and scheduled server-side.',
          },
          date: {
            type: "string",
            description:
              "Optional shared date for the whole batch, ONLY 'today', 'tomorrow', or an explicit YYYY-MM-DD. For any other phrasing keep it inline in each task string.",
          },
        },
        required: ["tasks"],
      },
    },
    // THE CONFIRM-INTENT / DEFINITION-OF-DONE GATE, on voice for the first time. Deliberately a
    // NARROWER schema than the text path's: text takes a model-supplied `task_id` AND a model-authored
    // `definition_of_done`, and is safe only because the turn engine injects the exact pending task id
    // and title into that agent's scene (huddle.functions.ts pendingConfirm). No such injection exists
    // on voice, so a model-supplied id would be a GUESS and a model-authored DoD would let an agent
    // manufacture a confirmation the user never gave. Neither is accepted here: the SERVER resolves
    // which task is awaiting a reply (getPendingConfirmForAgent) and the SERVER's own recorded proposal
    // is what gets confirmed. No outstanding ask -> the tool refuses. It fails CLOSED.
    {
      type: "function",
      name: "confirm_task_intent",
      description:
        "Lock in the Definition of Done for the task you are WAITING ON — call this ONLY when the user " +
        "has just answered your outstanding check-in about a task (\"yes, go ahead\", \"yep that's right, " +
        "but also…\"). You do not choose the task: it confirms the one check-in you are actually waiting " +
        "on, and refuses if you are not waiting on any — so never tell the user something was confirmed " +
        "unless this returned ok. The result gives you the task's title; say which task you locked in. " +
        "If they added or changed something, pass it as `additions`. If they declined or are still " +
        "deciding, do NOT call this.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          additions: {
            type: "string",
            description:
              "Optional. Anything the user added or corrected when they confirmed, in their words. It is appended to the plan you already proposed to them — it never replaces it.",
          },
        },
        required: [],
      },
    },
  );

  // Native artifact production — the voice agent was MISSING create_artifact (text-engine only), so on a
  // call it would SAY "let me generate that MD file" and produce nothing (ACT-huddle-40). Task-scoped
  // review flips stay a text concern; a voice-produced artifact saves with taskId=null (still reviewable
  // in the Artifacts panel). Same one-hop executor + createArtifact() the text path uses.
  raw.push({
    type: "function",
    name: "create_artifact",
    description:
      "Save a document (markdown/plain text) as a reviewable artifact the user can open, review, and " +
      "approve — a memo, plan, budget, brief, notes, or any file you produce for them. Call this WHENEVER " +
      "you produce a document; do not merely say you'll generate a file. Returns the saved artifact.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "File name, e.g. 'alabama-trip-budget.md'." },
        content: { type: "string", description: "The FULL document content (markdown/plain text)." },
        folder: { type: "string", description: "Optional folder/category, e.g. Finance, Research, Ventures. Default Research." },
        mime: { type: "string", description: "Optional MIME type. Default text/markdown." },
      },
      required: ["name", "content"],
    },
  });

  // Native email (Outlook/Graph) — mirror the TEXT engine. The voice agent was MISSING these, so a spoken
  // "email me X" fell through to a journey messaging/push tool and the user got a message instead of an
  // email (ACT-huddle-34). Same gate + schemas + dispatch (executeRealtimeTool) as the text path.
  try {
    const { graphEmailConfigured, emailFromOptions } = await import("../email/graph-email.server");
    if (graphEmailConfigured()) {
      const fromOpts = emailFromOptions();
      raw.push(
        {
          type: "function",
          name: "send_email",
          description:
            `Send an email via Microsoft (Outlook/Office 365). Sends from ${fromOpts[0]} by default; ` +
            `set "from" to one of: ${fromOpts.join(", ")} to send from a different mailbox. ` +
            `Requires a recipient (to), a subject, and a body. Use this whenever the user asks to email someone.`,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              to: { type: "string", description: "Recipient email address. Comma-separate multiple recipients." },
              subject: { type: "string", description: "Email subject line." },
              body: { type: "string", description: "Email body (plain text)." },
              from: { type: "string", description: `Optional sender mailbox. Defaults to ${fromOpts[0]}. Allowed: ${fromOpts.join(", ")}.` },
              cc: { type: "string", description: "Optional CC address(es), comma-separated." },
            },
            required: ["to", "subject", "body"],
          },
        },
        {
          type: "function",
          name: "create_email_draft",
          description:
            `Save a REAL draft email to the ${fromOpts[0]} mailbox's Drafts folder (does NOT send it). ` +
            `Use this when the user asks you to draft, prepare, or write up an email for later. A subject and body are required; recipients (to) are optional for a draft.`,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: { type: "string", description: "Email subject line." },
              body: { type: "string", description: "Email body (plain text)." },
              to: { type: "string", description: "Optional recipient address(es), comma-separated." },
              from: { type: "string", description: `Optional mailbox to draft in. Defaults to ${fromOpts[0]}. Allowed: ${fromOpts.join(", ")}.` },
              cc: { type: "string", description: "Optional CC address(es), comma-separated." },
            },
            required: ["subject", "body"],
          },
        },
      );
    }
  } catch {
    // Email is optional — voice still works without it.
  }

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
    "schedule_and_priorities",
    "get_calendar_events",
    "get_external_calendar_events",
    "schedule_reminder",
    "groom_backlog",
    "tavily_web_search",
    "send_email",
    "create_email_draft",
    "create_artifact",
  ]);
  try {
    if (name === "get_external_calendar_events") {
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
    if (name === "schedule_and_priorities" || name === "get_calendar_events") {
      const { dispatchPrioritize } = await import("../tasks/tools");
      const { resolveJourneyIdentity } = await import("../journey/identity");
      const ident = await resolveJourneyIdentity(ctx.caller, ctx.timeZone);
      const email = ident.email ?? ctx.caller?.entra_email;
      // get_calendar_events is a calendar-framed ALIAS → the same combined-schedule executor, defaulting
      // to the day's scheduled view (a model-supplied view still wins).
      const a = name === "get_calendar_events" ? { view: "scheduled", ...args } : args;
      return done(await dispatchPrioritize(email, a, ident.timeZone || ctx.timeZone || "UTC"));
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
    if (name === "send_email") {
      const { sendGraphEmail } = await import("../email/graph-email.server");
      const r = await sendGraphEmail({
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        from: args.from ? String(args.from) : undefined,
        cc: args.cc ? String(args.cc) : undefined,
      });
      return done(JSON.stringify(r));
    }
    if (name === "create_email_draft") {
      const { createGraphDraft } = await import("../email/graph-email.server");
      const r = await createGraphDraft({
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        from: args.from ? String(args.from) : undefined,
        cc: args.cc ? String(args.cc) : undefined,
      });
      return done(JSON.stringify(r));
    }
    if (name === "create_artifact") {
      const artName = String(args.name ?? "").trim();
      const content = String(args.content ?? "");
      if (!artName || !content) return done(JSON.stringify({ ok: false, error: "name and content are required" }));
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = (await resolveTaskEmail(ctx.caller ?? {})) ?? ctx.caller?.entra_email;
      if (!email) return done(JSON.stringify({ ok: false, error: "sign-in required" }));
      const { createArtifact } = await import("../artifacts/artifacts.server");
      // Voice artifacts aren't task-scoped (taskId=null) — they save straight to the Artifacts panel;
      // the task-scoped review-flip in the text path is intentionally skipped here.
      const { id, deepLink } = await createArtifact({
        userEmail: email,
        agentId: ctx.agentId,
        taskId: null,
        folder: String(args.folder ?? "Research"),
        name: artName,
        mime: String(args.mime ?? "text/markdown"),
        bytes: Buffer.from(content, "utf8"),
      });
      return done(JSON.stringify({ ok: true, id, deepLink }));
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
