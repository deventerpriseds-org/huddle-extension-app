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
// NOTE (v1 scope — NOW CLOSED; kept because the reason still governs what is here). create_huddle_task
// and create_artifact were once text-only because their executors are TURN-SCOPED inside runAgentTurn:
// they render UI board/artifact cards via per-turn state. create_artifact was retro-fitted first
// (ACT-huddle-40); create_huddle_task, create_huddle_tasks and confirm_task_intent followed once
// BATCH-3-RESULTS.md measured the gap. The turn-scoped half genuinely does not exist on a voice call
// (there is no board card to render into a phone), but the DURABLE half was extracted —
// tasks/create-task-core.ts and confirmTaskFromProposal in tasks/confirm-ask.functions.ts — and is
// CALLED here, never reimplemented. Ten other text-only tools stay text-only on purpose; the table of
// which and why is docs/cross-app-agent/FIX-voice-capability-gaps.md (nexus-hub).
//
// THE ASYMMETRY THAT BITES, and the one that produced the send_email defect: executeRealtimeTool
// dispatches on a local NATIVE set, and anything NOT in that set falls through to invokeJourneyTool.
// A Huddle-native tool added to buildRealtimeToolset but NOT to NATIVE is silently proxied to journey
// and fails there, with no telemetry to notice it. Add BOTH halves, every time.

import type { AgentId } from "../../data/agents";
import { AGENT_BY_ID } from "../../data/agents";
import { agentOwnsCapability } from "../capabilities";
import { getAssistantSnapshot } from "../openai-assistants.server";
import {
  // NOT the raw fetch: the ...ForHuddle variant drops journey tools Huddle owns natively
  // (HIDDEN_FROM_HUDDLE = web_search, send_email). Offering journey's recipient-less `send_email`
  // next to Huddle's native Graph one let the model pick the wrong same-named tool and mail the
  // owner instead of the intended recipient — the text path had always filtered; this one had not.
  fetchJourneyToolDefinitionsForHuddle,
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
// SHARED with the text turn engine — the exclusive-capability meta-task guard, cross-turn title dedup,
// journey date normalization and the honest outcome note. NOT a voice-local copy: huddle.functions.ts's
// two task-create closures call these same functions, so the surfaces cannot drift.
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
  "tool so it becomes a reviewable file. Only say you saved a document if `create_artifact` returned success." +
  " To ADD something to the user's board — \"add that to my board\", \"put that on my list\", \"remind me to " +
  "look at X\", \"track that\" — CALL `create_huddle_task`; for SEVERAL things in one breath call " +
  "`create_huddle_tasks` ONCE with all of them, never several single calls. Report the result honestly: " +
  "say the exact number created and mention anything it tells you was skipped as already on the board." +
  " If the user is ANSWERING a check-in you sent them about a task — \"yes, go ahead\", \"that's right\" — " +
  "CALL `confirm_task_intent` (pass anything they added as `additions`), then say which task you locked " +
  "in. Never say a task was confirmed unless that call returned ok.";

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
  // spoken "add that to my board" could not create a Huddle card (BATCH-3-RESULTS.md §3.2). It reached
  // only journey's raw quick_create_task from the catalog, which skips Huddle's exclusive-capability
  // meta-task guard, its cross-turn dedup, and the honest scheduled/deferred outcome note — the owner
  // got a journey task with none of Huddle's discipline. Same guards, same journey tools, same shared
  // helpers as the text path (tasks/create-task-core.ts).
  raw.push(
    {
      type: "function",
      name: "create_huddle_task",
      description:
        "Create ONE task when the user asks to add, log, track, capture, or put something on their " +
        "board. It lands on the Huddle board and their journey board in one call. For MORE THAN ONE " +
        "task in a single request use create_huddle_tasks instead. Report what the result actually " +
        "says — it tells you whether it was scheduled, is unscheduled, or was skipped as a duplicate; " +
        "only say it was added if the call returned ok.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description:
              'Short task title. Keep any time/date phrase inline in the title ("Renew passport by Friday") — it is parsed server-side.',
          },
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
        "call creates and co-schedules all of them, which on a live call is also much faster than " +
        "several. The result gives the EXACT number created plus anything skipped as a duplicate — " +
        "state that number, never assume they all landed.",
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
    // NARROWER schema than the text path's, and the narrowing is the safety property:
    //
    //   text: confirm_task_intent(task_id, definition_of_done)  — both model-supplied.
    //   voice: confirm_task_intent(additions?)                  — neither.
    //
    // Text is safe with model-supplied values only because the turn engine injects the exact pending
    // task id and title into that agent's scene first (huddle.functions.ts `pendingConfirm`). No such
    // injection exists on a voice session, so a model-supplied task_id would be a GUESS and a
    // model-authored definition_of_done would let an agent MANUFACTURE a confirmation the user never
    // gave — a bypass of the very gate, which is worse than the tool being missing. So neither is
    // accepted: the SERVER resolves which task is awaiting a reply for this agent
    // (getPendingConfirmForAgent, confirm_status='asked') and the SERVER's own recorded proposal is
    // what gets confirmed, through the same confirmTaskFromProposal the model-free Confirm button
    // uses. No outstanding ask -> refuse. It fails CLOSED.
    {
      type: "function",
      name: "confirm_task_intent",
      description:
        "Lock in the Definition of Done for the task you are WAITING ON — call this ONLY when the user " +
        "has just answered your outstanding check-in about a task (\"yes, go ahead\", \"yep, but also " +
        "include Q3\"). You do not choose the task: it confirms the one check-in you are actually " +
        "waiting on, and refuses if you are not waiting on any — so never tell the user something was " +
        "confirmed unless this returned ok. The result gives you the task's title; say which task you " +
        "locked in. If they added or changed something, pass it as `additions`. If they declined, or " +
        "are still deciding, do NOT call this.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          additions: {
            type: "string",
            description:
              "Optional. Anything the user added or corrected as they confirmed, in their own words. It is appended to the plan you already proposed to them — it never replaces it.",
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
      const defs = await fetchJourneyToolDefinitionsForHuddle();
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
  // EVERY name offered by buildRealtimeToolset as a Huddle-native tool MUST be in this set. It is the
  // ONLY thing standing between a native tool and the `if (!NATIVE.has(name))` journey fallthrough
  // below — a native name missing from here is silently proxied to journey, where it does not exist,
  // and fails with a journey error the model reports as the tool being broken. There is no telemetry
  // on this path to catch it (buildRealtimeToolset never calls recordToolUse), which is why
  // scripts/voice-toolset-hidden.test.ts asserts definition-and-NATIVE together for each one.
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
    "create_huddle_task",
    "create_huddle_tasks",
    "confirm_task_intent",
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
    // Task capture — ONE executor for both arities. Runs the SAME guards as the text path, from the
    // SAME module (tasks/create-task-core.ts): the exclusive-capability meta-task guard, then
    // cross-turn dedup against the user's open titles, then journey. Everything that survives goes
    // through journey's own tools — quick_create_task for one, parse_and_create_tasks for several
    // (one round trip and a conflict-aware co-schedule, instead of N sequential hops of dead air on a
    // live call).
    //
    // ONE DELIBERATE DIVERGENCE FROM TEXT, and it is the honest direction: the text path falls back to
    // a Huddle-only board CARD when journey is off or fails. A voice call has no card to render, so
    // there is no such fallback here — a failed journey write is reported as a FAILURE, never as
    // "added it". That matches the text path's own reasoning for its journeyFailed branch: journey is
    // canonical, so no journey row means the task exists nowhere.
    if (name === "create_huddle_task" || name === "create_huddle_tasks") {
      const entries =
        name === "create_huddle_task"
          ? [String(args.title ?? args.task ?? args.name ?? "").trim()].filter(Boolean)
          : splitTaskEntries(args);
      if (entries.length === 0) {
        return done(
          JSON.stringify({
            ok: false,
            error:
              name === "create_huddle_task"
                ? "create_huddle_task requires a title"
                : "create_huddle_tasks requires a non-empty `tasks` array",
          }),
        );
      }

      const seen = await loadOpenTaskTitles(ctx.caller);
      const survivors: string[] = [];
      const deferred: Array<{ title: string; handedTo?: string; reason: string }> = [];
      const skipped: Array<{ title: string; reason: string }> = [];
      for (const entry of entries) {
        const owner = screenCapabilityMetaTask(entry, ctx.agentId);
        if (owner) {
          deferred.push({ title: entry, handedTo: owner.handedTo, reason: owner.reason });
          continue;
        }
        const key = normalizeTaskTitle(entry);
        if (seen.has(key)) {
          skipped.push({ title: entry, reason: "an open task with this title already exists" });
          continue;
        }
        seen.add(key); // also dedups repeats WITHIN this one call
        survivors.push(entry);
      }
      if (survivors.length === 0) {
        return done(
          JSON.stringify({
            ok: true,
            requested: entries.length,
            created: 0,
            deferred,
            skipped,
            note: deferred.length
              ? deferred[0].handedTo
                ? `That is ${deferred[0].handedTo}'s exclusive job — do not file a task about it.`
                : "That is your own job to perform, not a task to file."
              : "Nothing new — it is already on their board. Say so plainly.",
          }),
        );
      }

      const dateArg = normalizeJourneyDate(args.date);
      const jctx = { source: "huddle" as const, huddleId: ctx.huddleId, agentId: ctx.agentId };
      if (survivors.length === 1) {
        const title = survivors[0].slice(0, 160);
        const r = await invokeJourneyTool({
          toolName: "quick_create_task",
          args: dateArg ? { title, date: dateArg } : { title },
          caller: ctx.caller ?? {},
          context: jctx,
        });
        if (!r.ok) {
          return done(
            JSON.stringify({
              ok: false,
              error: `Could not save “${title}” to the board: ${r.error ?? "unknown error"}`,
              note: "Tell the user plainly that it was NOT saved and offer to try again — do not claim it was added.",
            }),
          );
        }
        const { outcome, note } = summarizeQuickCreateOutcome(r.output);
        return done(
          JSON.stringify({
            ok: true,
            created: 1,
            task: { title },
            outcome,
            note,
            deferred,
            skipped,
            boards: ["huddle", "journey"],
          }),
        );
      }
      const r = await invokeJourneyTool({
        toolName: "parse_and_create_tasks",
        args: {
          text: survivors.join("\n"),
          auto_schedule: true,
          ...(dateArg ? { target_date: dateArg } : {}),
        },
        caller: ctx.caller ?? {},
        context: jctx,
      });
      if (!r.ok) {
        return done(
          JSON.stringify({
            ok: false,
            error: `Could not save those ${survivors.length} tasks to the board: ${r.error ?? "unknown error"}`,
            note: "Tell the user plainly that NONE of them were saved and offer to try again — do not claim any were added.",
          }),
        );
      }
      // Recover the true created COUNT rather than assuming every survivor landed — the whole reason
      // the batch tool exists is that a model otherwise narrates "created all of them".
      let created = r.tasks?.length ?? 0;
      if (created === 0) {
        try {
          const parsed = JSON.parse(r.output) as { tasks?: unknown[]; created?: number };
          created =
            typeof parsed.created === "number" ? parsed.created : (parsed.tasks?.length ?? survivors.length);
        } catch {
          created = survivors.length;
        }
      }
      return done(
        JSON.stringify({
          ok: true,
          requested: entries.length,
          created,
          attempted: survivors.length,
          deferred,
          skipped,
          boards: ["huddle", "journey"],
          note: `State the exact number created (${created}); do not say "all of them" unless it matches what they asked for.`,
        }),
      );
    }

    // THE CONFIRM-INTENT / DoD GATE on voice. The model supplies NOTHING that decides anything: the
    // server picks the task (the one confirm ask this agent actually has outstanding) and the server's
    // own recorded proposal is the DoD, via the same confirmTaskFromProposal the model-free Confirm
    // button calls. See the schema comment in buildRealtimeToolset for why this is narrower than text.
    // Every failure path REFUSES — no outstanding ask, no ownership, no recorded proposal, no confirm.
    if (name === "confirm_task_intent") {
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = (await resolveTaskEmail(ctx.caller ?? {})) ?? ctx.caller?.entra_email;
      if (!email) return done(JSON.stringify({ ok: false, error: "sign-in required" }));
      const { getPendingConfirmForAgent } = await import("../tasks/tasks.server");
      // confirm_status='asked' AND assigned_agent = this agent AND not DONE AND not blocked.
      const pending = await getPendingConfirmForAgent(email, ctx.agentId);
      if (!pending) {
        return done(
          JSON.stringify({
            ok: false,
            error: "You have no outstanding confirm-intent check-in, so there is nothing to confirm.",
            note: "Do NOT tell the user anything was confirmed. If they meant a different task, help them with it normally.",
          }),
        );
      }
      const { confirmTaskFromProposal } = await import("../tasks/confirm-ask.functions");
      const r = await confirmTaskFromProposal({
        caller: ctx.caller ?? {},
        taskId: pending.taskId,
        email,
        additions: typeof args.additions === "string" ? args.additions : undefined,
      });
      return done(
        JSON.stringify({
          ok: r.ok,
          error: r.error,
          alreadyDone: r.alreadyDone,
          task_id: r.ok ? pending.taskId : undefined,
          title: pending.title,
          note: r.ok
            ? `Locked in. Tell the user briefly which task you confirmed: “${pending.title}”.`
            : "It was NOT confirmed — say so; do not claim otherwise.",
        }),
      );
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
