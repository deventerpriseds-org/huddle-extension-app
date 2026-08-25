import { createServerFn } from "@tanstack/react-start";
import { generateText, tool, stepCountIs, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import type { HuddleMessage, SuggestedTaskDraft, TaskLane } from "../data/seed";
import {
  parseMentions,
  routeMessage,
  routeMessageLLM,
  scoreDifficultyLLM,
  laneOwnerFor,
  resolveOwnerLLM,
  type RouterInvocation,
  type RouteResult,
} from "./routing";
import {
  isQuotaError,
  QUOTA_OUTAGE_INLINE,
  type FallbackEvent,
  type PromptDebug,
} from "./fallbacks";
import { buildRoster } from "./roster";
import {
  resolveByDifficulty,
  resolveModel,
  withAgentCeilings,
  type ModelPolicy,
  classifyTaskType,
  DEFAULT_MODEL_POLICY,
  type Effort,
} from "./model-policy";
import {
  agentOwnsCapability,
  exclusiveCapabilities,
  capabilityOwnerFor,
  classifyTurnIntent,
  type TurnIntent,
} from "./capabilities";
import {
  detectCeremony,
  buildCeremonyReport,
  lanesByOwner,
  roundRobinParticipants,
  ownerDirective,
  openerDirective,
  closerDirective,
  narrateDirective,
  bargeDirective,
  boardDigestNamed,
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
import { GET_CALENDAR_EVENTS_TOOL, GET_EXTERNAL_CALENDAR_EVENTS_TOOL } from "./calendar/tools";
import {
  DELEGATE_TO_SPECIALIST_TOOL,
  workerDirectory,
  getWorker,
  WORKER_ROLES,
} from "./agents/workers";
import {
  FLAG_BLOCKER_TOOL,
  CONFIRM_TASK_INTENT_TOOL,
  PROPOSE_TASK_INTENT_TOOL,
  PROPOSE_APPROACH_TOOL,
  ASK_CLARIFYING_QUESTION_TOOL,
  RESOLVE_CLARIFYING_QUESTION_TOOL,
} from "./tasks/task-agent-tools";
import { GENERIC_SUPPORT_NOTE } from "./agents/domain-roles";

// Feature flag: gates the intent-classification guard on capability/lane hand-off.
// Set to false for an instant rollback to the previous (trigger-word-only) behaviour.
const TURN_INTENT_CLASSIFICATION = true;

// Feature flag: keyword-driven TOOL FORCING (reminderRe/createTaskRe/timeSensitiveRe → tool_choice).
// OFF by design. Those regexes were a DIVERGENT keyword-intent layer parallel to the semantic systems
// (the LLM router + classifyTurnIntent) — deciding which tool to force from surface keywords instead of
// meaning. That split is exactly what made "remind me what we decided" force schedule_reminder. With
// this false, tool_choice stays model-native ("auto") and the agent selects tools SEMANTICALLY from
// their descriptions. The regexes/branches are kept (not deleted) so this is a one-line rollback if the
// model proves to under-call a tool on a given deployment — a reliability tradeoff that must be
// confirmed on live turns (watch for the historic "I'll add it" with no card, or a missed reminder).
const KEYWORD_TOOL_FORCING = false;

// Feature flag: B2 assignee-scoped task-STATUS changes. When on, an agent may change an existing
// task's status (update_task with a `status` arg) ONLY if it is that task's assignee (assigned_agent)
// or the board owner (special:"coordinator"). Otherwise the change is a graceful DEFERRAL to the
// assignee — the board's ownership stays honest even when the user addressed a non-owner. Data-driven
// off the real assigned_agent mirror; extends the existing meta-task-guard ownership model to status
// changes (not just task creation). Set false to disable.
const ASSIGNEE_SCOPED_STATUS = true;

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
  // Away-gate for the reply PUSH: true when the client is foregrounded AND actively viewing THIS
  // huddle at send time — i.e. the user is right here and will see the reply in-app, so a phone
  // notification would be redundant noise. Absent/false on cron-backstop and agent-initiated turns
  // (user away) → push fires normally. Only gates the "X replied" messages push; reminders/alarms are
  // always delivered regardless.
  foreground: z.boolean().optional(),
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
  // Pillar 2: artifacts to surface as "Open <name>" chips on the TARGET agent's reply this turn, even
  // though this agent didn't create them — used by a delegation INTEGRATION turn to reference the
  // specialist documents its workers produced. Purely presentational; carried in the durable payload.
  attachArtifacts: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(12)
    .optional(),
  // System-originated turn (autowork research, standup/grooming digest, an owner follow-up, a delegation
  // integration) — NOT a real user message. Its `text` is an internal DIRECTIVE, so the 1:1 pass-along
  // and lane-deferral machinery must NOT run on it: doing so mis-reads the directive as "a user ask in
  // the wrong lane" and spawns follow-ups that re-trigger follow-ups (the notification-barrage loop).
  internal: z.boolean().optional(),
  // A live-ceremony BARGE-IN answered synchronously (the client's runBargeSequence, not the durable
  // ceremony queue). When set on a group turn, the responder the router picks gets the existing
  // bargeDirective() layered onto its scene — "the user just cut into a live stand-up, address them
  // directly in 1–2 sentences, don't give a lane update" — so a barge answer is stand-up-aware
  // instead of a generic off-context reply. Reuses the same bargeDirective() the durable path uses.
  ceremonyBarge: z.boolean().optional(),
  // Live-ceremony run id (client-minted in MeetingBar). When present, every tool this turn invokes is
  // persisted to chat.ceremony_transcript (kind='tool') so a reviewer can prove "the agent SAID it
  // parked but no update_task row exists" vs "row exists, tool_ok=false". Debug tracking only.
  ceremonyRunId: z.string().optional(),
  // Short-term memory mechanism (Settings → Memory). "reconstruction" (default + only active mode) =
  // app-managed transcript + explicit self-recall injection. "responses-chain"/"conversation" are
  // SCAFFOLD: they carry through but the runtime logs a marker and behaves as reconstruction (no
  // OpenAI-native state plumbing yet). Absent → reconstruction.
  memoryMode: z.enum(["reconstruction", "responses-chain", "conversation", "researched"]).optional(),
  // Manual model/thinking override for THIS turn (the "change the model/thinking myself" fallback, like
  // most AI UIs). "sol" = force Sol-high, "budget" = force the Terra-high budget tier, or a ladder label
  // (e.g. "luna-high", "sol-max"). Always wins over the difficulty-driven auto-pick AND clears the Sol
  // deep-confirm gate. Absent → fully automatic (difficulty scorer drives the tier).
  modelEscalate: z.string().max(24).optional(),
  // Reply streaming toggles (Settings). 1:1 (one responding agent) streams the reply's tokens into the
  // durable row as they form, so a slow high-effort answer shows up incrementally via the client poll
  // instead of being cut at the turn deadline. Groups/ceremonies default OFF (the shared sequential
  // live-call model is unchanged). Absent → 1:1 on, group off.
  streamReplies: z.object({ oneOnOne: z.boolean(), group: z.boolean() }).partial().optional(),
  // The user's model policy (difficulty/task-type → tier + per-agent ceilings), from the Settings config.
  // Absent → DEFAULT_MODEL_POLICY. Trusted local config, so validated loosely.
  modelPolicy: z.custom<ModelPolicy>().optional(),
  // Files the user attached to THIS message (uploaded to the blob store first via uploadChatAttachmentFn,
  // so only the ids travel here — not the bytes). The server resolves each id to a fresh read SAS
  // (images → OpenAI vision content parts) or decoded text (inlined), so the addressed agent can actually
  // use a screenshot / invite / appointment the user shared. ACT-45.
  attachments: z
    .array(z.object({ id: z.string().min(1), name: z.string(), mime: z.string() }))
    .max(6)
    .optional(),
});

const MAX_REPLIES_PER_TURN = 4;

/** The user's model policy for this turn (Settings config, default seeded) with per-agent ceilings
 *  overlaid from each agent's Settings-chosen model — the single place the resolver's policy is built,
 *  so interactive turns and the auto-worker agree. */
function effectiveModelPolicy(
  agents: Record<string, { model?: string } | undefined> | undefined,
  modelPolicy: ModelPolicy | undefined,
): ModelPolicy {
  const models: Partial<Record<AgentId, string | undefined>> = {};
  for (const [id, ab] of Object.entries(agents ?? {})) models[id as AgentId] = ab?.model;
  return withAgentCeilings(modelPolicy ?? DEFAULT_MODEL_POLICY, models);
}

// Shared house-style layer — appended to EVERY agent's instructions regardless of
// whether the domain content came from the platform snapshot, a client override,
// or the in-repo persona. Formatting is a Huddle presentation concern that belongs
// in one place, not baked into each agent's prompt; changing it here changes it for
// all agents. (Lane ownership / handoffs are already shared, generated dynamically
// by buildRoster from agents.ts.)
const HOUSE_STYLE =
  "\n\nFormat every reply in the Huddle house style: plain prose in sentence case — no emoji, no markdown headings or bolded section headers, and no long bullet dumps unless the user explicitly asks for a list or a detailed breakdown. Do not prefix your reply with your own name or a bracketed label; the UI already shows who you are. Keep it to 1–3 short sentences unless the user asks for detail." +
  ' Never claim an action was actually carried out — sent, emailed, scheduled, booked, created, updated, cancelled, or completed — unless you called a tool THIS turn that performed it and it returned success. If you only drafted, proposed, or planned something, say exactly that; never state it "has been sent" or "is done" when it has not. Email specifically: text you write in the chat is "draft text" — only say you "saved a draft to your inbox" if you called the create_email_draft tool and it returned success, and only say an email was "sent" if send_email returned success.' +
  ' Tool results are ground truth: if a tool result contains an "error" field or otherwise reports failure, the action did NOT happen — tell the user plainly that it didn\'t work (one short sentence) and do NOT claim it succeeded, is scheduled, or will happen. Never paper over a failed tool with a confident success message.' +
  ' Be precise about QUANTITY: when you report how many of something you did — tasks created, emails sent, items scheduled, reminders set — state the EXACT number the tool result gives you (e.g. its `created` count), not the number requested. If you were asked for two and the tool created one, say you created one and that the other didn\'t go through (or was already there); never round up to "both" or "all of them" unless the tool\'s own count confirms it.' +
  " Your capabilities are exactly the tools you have this turn — nothing more. If you're asked or assigned something you cannot actually do with those tools (e.g. move money, buy something, take a real-world action only the user can), do NOT pretend, vaguely promise, or invent a result — say plainly in one sentence what you can't do and why. Almost always you CAN still make real progress by researching, analyzing, or drafting — do that instead. If it's a task on the board and you genuinely cannot advance it (it needs the user's decision, a credential, or a capability you don't have), call flag_blocker(task_id, reason) with the specific reason so the user knows exactly what you need." +
  " REAL-WORLD ACTIONS ONLY THE USER CAN DO (making a payment or money transfer, a purchase, signing, physically going somewhere) are NOT things you drop or merely decline: capture the item as a task on the USER's board (create_huddle_task) framed as theirs to execute — e.g. \"that Klarna payment is yours to make; I've added it and I'll track and remind you\" — never claim you did it, and do NOT flag_blocker it (a payment the user will make is not blocked — it is simply the user's to do, so TRACK it, don't drop it). This is ASSIST mode: the user acts, you capture/remind/prep. Only use flag_blocker when a task genuinely cannot move forward at all without a decision, credential, or capability neither of you can supply." +
  " A background lookup that comes up empty should be invisible to the user: never narrate that you searched, where you looked, or that something wasn't found — just answer directly from what you know, your live tools, and the conversation. Above all, ANSWER THE USER'S ACTUAL LAST MESSAGE: if they correct you (e.g. \"your time zone is wrong\") or ask something specific, address exactly that instead of falling back to a generic non-answer that ignores what they just said.";

// Executive-grade OUTPUT CONTRACT — the distilled essence of the Huddle agent operating standard
// (full version: docs/huddle-agent-architecture.md). Appended to EVERY agent on BOTH backends. It raises
// the SUBSTANCE bar without fighting the house style: chat replies stay concise (HOUSE_STYLE governs form),
// while any DOCUMENT/ARTIFACT you produce gets the full structured treatment.
const OPERATING_CONTRACT =
  "\n\nYou are an accountable member of the user's executive team, not a search box. For any substantive " +
  "request, think through four levels and let them shape your answer: informative (what the evidence " +
  "establishes), analytical (why it matters — causes, patterns, implications), actionable (what to do, who " +
  "owns it, in what order, and how success is measured), and strategic (tradeoffs, risks, opportunities, " +
  "and the decisions that follow). Never hand over raw information without interpreting its relevance to " +
  "the user's goals." +
  " Evidence discipline: base material claims on the most authoritative source available; separate verified " +
  "facts from assumptions and inferences; flag conflicting or missing evidence; and state a confidence level " +
  "whenever uncertainty could change the recommendation — do not substitute confident wording for verification." +
  " Make recommendations decision-ready: the action, the finding it rests on, the rationale, priority, owner, " +
  "timing, key risks, and your confidence — and separate immediate actions from near-term ones, longer-term " +
  "strategic moves, and decisions that need the user's approval." +
  " Finish only when the work is genuinely usable: every requested deliverable exists, claims trace to " +
  "evidence, uncertainties are disclosed, and the single clearest next action is explicit. Complete every " +
  "non-blocked part first, then escalate (ask the user) before anything irreversible, external, or financial." +
  " Routine capture on the user's OWN workspace — adding a task, reminder, or calendar event; updating a card; " +
  "saving a note or artifact — is reversible and expected: it is NOT the 'irreversible/external/financial' that " +
  "requires asking first, so just do it and report it. Only genuinely OUTBOUND actions (sending a message, a " +
  "purchase or moving money, placing a call, a deletion) need that confirmation." +
  " FORM: in chat, deliver all of this as tight, high-signal prose sized to the question — not headings or " +
  "long lists. When you produce a document via create_artifact, give it the FULL structure: an executive " +
  "conclusion, key findings with their evidence, analysis, prioritized recommendations (with owner/timing/" +
  "risk), risks & assumptions, and the sources you used." +
  " Documents & links: when you save work with create_artifact the app renders it as a clickable chip on " +
  "your message automatically — so NEVER write your own link to “the document,” never present an external " +
  "website URL as a document you produced, and never say you compiled, attached, prepared, or created a " +
  "document unless you actually called create_artifact THIS turn and it succeeded. If you did not save one, " +
  "just give the findings directly in your message. You may cite a real source URL as a plain reference, " +
  "but do not dress it up as “the document I put together.”";

// Proactive-capture layer — the systematic "act on relayed information, don't just acknowledge it" standard.
// Appended to EVERY agent on BOTH backends (alongside OPERATING_CONTRACT). It is data-driven, NOT per-agent:
// it references "the tools you have THIS turn" and "your lane", so it covers every present/future agent with
// zero per-agent code (same principle as the capability hand-off). The user relays information — a screenshot
// of an appointment, a forwarded email/SMS, an accepted invite, a booking, a fact, an article — that IMPLIES
// a follow-up the addressed agent owns; the old default was to reply "noted" and do nothing. This makes the
// default "take the obvious reversible action and report it", while keeping the narrow outbound/financial
// boundary intact (that half reconciles with OPERATING_CONTRACT's escalate clause, clarified above).
const PROACTIVE_CAPTURE =
  "\n\nProactive capture — act on what the user relays, don't just acknowledge it. When the user STATES or " +
  "RELAYS something that implies a follow-up you can own — a commitment, appointment, deadline, or task they " +
  "mention in passing (even without saying \"add this\"); a screenshot or forward of an email, SMS, or other " +
  "correspondence; an invite they accepted; a booking they confirmed; a fact or preference worth remembering; " +
  "or a document, idea, or reading to keep — take the obvious low-risk action with the tools you have THIS turn " +
  "and report what you did in one short line, instead of only replying that you noted it. Concretely, in your " +
  "own lane with your own tools: an appointment or a date → create the task or calendar event and set its " +
  "`date`; a received message that needs a reply → DRAFT the reply (do not send it); something they say is done " +
  "→ update the card; a fact or preference → save it; an article, recipe, or idea to keep → capture it as an " +
  "artifact or note. Prefer doing-and-reporting over asking: ask ONLY when the target is genuinely ambiguous " +
  "(which of several calendars, an exact time you truly cannot infer) — and even then, STILL perform the capture " +
  "using your single best-assumption value (a sensible default date, time, or slot) and tell the user what you " +
  "assumed so they only have to correct it; never withhold the capture itself behind a question. A vague " +
  "timeframe ('sometime this week', 'later') is not a reason to interrogate — pick a reasonable default, capture " +
  "it, and offer to adjust. This is " +
  "the same standard for every agent; capture in YOUR lane with YOUR tools." +
  " The one boundary that still requires asking first is narrow: genuinely OUTBOUND, IRREVERSIBLE, or FINANCIAL " +
  "actions that reach outside the user's own workspace — SENDING an email/message, placing a call, making a " +
  "purchase or moving money, or deleting something. For those, draft or propose and confirm before executing. " +
  "Adding or updating a task, reminder, calendar event, note, list, or artifact on the user's OWN workspace is " +
  "reversible and expected — never withhold that routine capture behind a confirmation request.";

// Persona-as-orchestrator layer (Pillar 2). Appended to every PERSONA's instructions (workers get
// their own charter instead). It tells a persona it leads shared specialists it can delegate to, and
// that it stays accountable for the single integrated answer. The worker roster is DATA (workers.ts),
// so adding a specialist changes this block with zero code — same systematic-capability principle as
// the capability hand-off. It does NOT fight HOUSE_STYLE: chat stays concise; delegation is a backstage
// move whose visible surface is a brief "I've put the team on it" + the later integrated answer.
const DELEGATION_DIRECTIVE =
  "\n\nYou lead a team of shared specialists you can hand a workstream to with the delegate_to_specialist " +
  "tool. Delegate when a request genuinely needs specialist depth, several parallel workstreams, or an " +
  "independent review — not for something you can already answer well yourself. You remain ACCOUNTABLE: " +
  "the specialists work behind the scenes and report to you, and YOU integrate their findings into the " +
  "single answer the user sees (never hand back raw specialist reports). Available specialists:\n" +
  workerDirectory() +
  "\nDelegation is asynchronous — specialists take seconds to minutes. After you delegate, tell the user " +
  "in one short line that you've put the team on it and will bring it together shortly; never invent or " +
  "pre-empt their results. When their work comes back you'll be asked to integrate it. " +
  GENERIC_SUPPORT_NOTE;

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
// includeRule: when false, return the ownership directory only (no behavioural deferral prose).
// Used when intent is "query" — the agent needs "Terry owns grooming" to answer ownership
// questions, but must not receive the deferral rule (LLMs apply prose contextually against full
// conversation history; a trigger-word in prior turns will cause a false deferral regardless of
// any "IMPORTANT: only when..." qualifier). For "status"/"ack"/"inform" the caller passes "".
function capabilityHandoffBlock(
  scope: "group" | "1:1",
  members: readonly AgentId[],
  selfId: AgentId,
  includeRule = true,
): string {
  // Which exclusive owners to surface depends on scope. GROUP: only owners actually present
  // (they can be @mentioned into the turn). 1:1: the owner is NEVER in a 1:1 (a DM has one
  // agent), so filtering by members would yield NOTHING and the addressed agent would get no
  // hand-off instruction — the exact bug where Tess improvised grooming instead of deferring.
  // Use the FULL roster in a 1:1 so ownership is known even though the owner isn't in the room.
  const owned = scope === "1:1" ? exclusiveCapabilities() : exclusiveCapabilities(members);
  if (owned.length === 0) return "";
  const directory = owned
    .map(
      (o) =>
        `- ${o.cap.label} → @${o.agent.handle}${o.agent.id === selfId ? " (you own this)" : ""}`,
    )
    .join("\n");
  if (!includeRule) {
    return "\n\nCapability owners (for reference only):\n" + directory;
  }
  const rule =
    scope === "group"
      ? 'If you are asked to do an exclusive job you do NOT own, do NOT attempt it and do NOT create a task about it — @mention the owner so they pick it up. If YOU own the job being asked for, just do it and briefly say what you did and why (e.g. "took care of grooming — the backlog was stale"); do not ask permission first or defer.'
      : "This is a 1:1, so the owner is NOT in this conversation. IMPORTANT: this deferral rule applies ONLY when the user's CURRENT message is explicitly asking you to PERFORM the capability (e.g. 'can you groom the backlog?', 'triage the backlog', 'plan the sprint'). Do NOT apply it when the user is: confirming something is done ('mark that done', 'that's finished', 'it's closed', 'already done'), asking a factual question about ownership ('who handles grooming?', 'what does Terry do?', 'is the session scheduled?'), acknowledging or thanking ('got it', 'ok', 'thanks'), or sharing information without requesting action. Never defer based on a related word appearing in earlier conversation turns — only the user's CURRENT message determines whether a performance request is being made. If you are asked to do an exclusive job you do NOT own, do NOT attempt it, do NOT improvise your own version of it (no grooming pass, no proposing owner assignments), and do NOT create a task about it. Say plainly, in one warm sentence, that the owner (refer to them by NAME, e.g. \"Terry\") is better suited and that you'll have them reach out — do NOT use an @handle (they are not in this 1:1; @ is for group rooms). The system brings them in automatically. If YOU are the owner, just do it.";
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

// D (F12) — server-side backstop for the "ran a tool, said nothing" barge. When a CEREMONY BARGE
// responder executes a real tool but the model returns EMPTY text, we must NOT emit a silent
// tool-only turn (the exact bug: Terry ran three web searches, spoke zero words). Synthesize a
// minimal, HONEST reply: acknowledge + defer to after the stand-up (we don't have a spoken
// deliverable in hand, so we say we'll follow up — never fabricate a result). Varied so a repeat
// doesn't sound canned. The bargeDirective now also instructs the model to say this itself; this is
// the code guarantee for when it still comes back empty.
function bargeToolDeferralText(): string {
  const opts = [
    "Got it — I ran that down and I'll bring you the result right after we wrap.",
    "On it — I pulled that up; I'll get you the details the moment the stand-up finishes.",
    "Heard you — I checked into that and I'll follow up with what I found right after we're done here.",
    "Understood — I looked into it; I'll surface the full result as soon as we close out the stand-up.",
  ];
  return opts[Math.floor(Math.random() * opts.length)];
}

// A small model keeps hand-authoring a link to "the document" in its chat prose — either an INVENTED
// external site ("access it [here](salesforce.com)") or a PLACEHOLDER ("[here](https://your-link-to-
// artifact)") — even when it DID save a real artifact. The chip (from create_artifact) is the ONLY real
// document link; a self-authored one is always fake or redundant. Prose rules don't bind a small model
// (repo principle: a firing trap is signal → guard in code), so we sanitize EVERY reply:
//   • a markdown link with a generic doc-pointer anchor (here/this/the document/…) or an obviously
//     placeholder URL → drop it to plain anchor text (kills the fake "open the document" link);
//   • any other markdown link (a genuine external citation like [McKinsey 2025](url)) → keep its URL as
//     plain, non-clickable text "anchor (url)" so nothing useful is lost and nothing looks clickable-fake.
const GENERIC_DOC_ANCHOR =
  /^(here|this|that|link|this link|the link|it|view it|access it|read it|see it|open it|download|download it|this document|the document|document|this doc|the doc|doc|this file|the file|file|this report|the report|report|this analysis|the analysis|the artifact|this artifact|view the document|click here|the doc(ument)? here)$/i;
const PLACEHOLDER_URL =
  /(your-link|link-to|link-here|url-here|insert[-_]?link|example\.com|artifact-link|placeholder|yourdomain|to-artifact|<link>)/i;
function stripAgentReplyLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, anchor, url) => {
    const a = String(anchor).trim();
    if (GENERIC_DOC_ANCHOR.test(a) || PLACEHOLDER_URL.test(url)) return a; // fake/placeholder doc-link → drop URL
    return `${a} (${url})`; // genuine citation → keep URL as plain, non-clickable text
  });
}

// Backstop for the "I looked in your files" narration. Root cause traced to our OWN HOUSE_STYLE prompt
// (below), which used to quote the banned phrase verbatim as a "don't say this" example — a model will
// readily echo a quoted example even when it's framed as prohibited. HOUSE_STYLE no longer quotes it, but
// this deterministic regex stays as a defense-in-depth backstop (a prose-only rule is never a hard
// guarantee against any model/tool combination) — same reason stripAgentReplyLinks exists above for fake
// document links, a different prose rule the model also didn't reliably follow). Strips just the
// file-mention clause so the sentence still reads naturally, e.g. "I couldn't find the email in the
// uploaded files." -> "I couldn't find the email." Confirmed live across iris-chase, finn-reid, and cam-post.
const FILE_MENTION_CLAUSE =
  /\s*\b(?:in|from|within)\s+(?:the|your|any|our)?\s*(?:uploaded\s+)?(?:files?|documents?|knowledge\s*base|attachments?)\b/gi;
function stripFileMentionNarration(text: string): string {
  return text.replace(FILE_MENTION_CLAUSE, "");
}

// Per-agent WIP-limited board flow: an agent's DOING task moves to IN_REVIEW the instant it actually
// finishes its work (saves an artifact) — never to DONE. DONE is set ONLY by the user, by hand, in the
// board UI (see docs on the flow in tasks/autowork.server.ts). The actual flip + retry + blocked-flag
// logic lives in tasks/tasks.server.ts's ensureReviewFlip (used here and by autowork's self-heal pass).

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
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`${name} timed out after ${timeoutMs / 1000}s`)), timeoutMs),
      ),
    ]);
    return typeof out === "string" ? out : JSON.stringify(out ?? {});
  } catch (e) {
    return JSON.stringify({
      error: "tool_failed",
      tool: name,
      message: e instanceof Error ? e.message : String(e),
    });
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
  // Terry's CLOSING turn, pending until the round-robin drains: [closerId, rendered closerDirective].
  // Kept out of ceremonyDirectives because the host already maps to the OPENER there; null once closed.
  ceremonyCloser?: [AgentId, string] | null;
  replyCap: number;
  replies: {
    agentId: AgentId;
    text: string;
    fallbackNotes?: string[];
    artifacts?: { id: string; name: string }[];
    confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
  }[];
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
// A short, UNAMBIGUOUS confirmation reply ("yes", "sounds good", "go ahead"). Used to record a pending
// confirm-intent deterministically without the model. Deliberately conservative: a question, a negation,
// or anything long enough to be a real refinement returns false and is left to the model + the injected
// directive (which asks it to call confirm_task_intent with the final, folded-in DoD).
function isPlainConfirmation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 40) return false;
  if (t.includes("?")) return false;
  if (/\b(no|not|don'?t|stop|wait|hold|cancel|nope|instead|change|revise|actually)\b/.test(t))
    return false;
  return /\b(yes|yep|yeah|yup|confirm(ed)?|correct|right|sounds good|looks good|go ahead|do it|that works|works for me|perfect|approved?|okay?|ok|sure|great|👍)\b/.test(
    t,
  );
}

/** Conservative "the blocker is cleared" matcher — used to route an unblock reply from a non-owner
 *  (e.g. the coordinator who surfaced the blocker) to the OWNING agent. Broader than a plain confirm
 *  because a real unblock is usually a sentence ("you're cleared, go ahead"). Negations short-circuit. */
function looksLikeUnblock(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\b(no|not|don'?t|stop|wait|hold|cancel|nope|keep it blocked|still blocked|leave it)\b/.test(t)) return false;
  return /\b(unblock|un-block|cleared|clear it|resolved|proceed|go ahead|green ?light|good to go|all set|move it forward|out of blocked|got you access|you'?re cleared|you can (go|proceed|start))\b/.test(
    t,
  );
}

/** Derive a board-task title from a freeform deep ask. Strips leading "can you / please / I need you
 *  to …" politeness/question framing so the card reads like a task, keeps the first sentence, caps
 *  length, and capitalizes. Best-effort text munging — never throws. Used by the produce-vs-quick gate. */
function produceTitleFrom(ask: string): string {
  let t = (ask || "").trim().replace(/\s+/g, " ");
  // First sentence / line only (a deep ask can be a paragraph; the title is the headline).
  const firstBreak = t.search(/[.!?\n]/);
  if (firstBreak > 24) t = t.slice(0, firstBreak);
  // Strip common lead-ins so "Can you research X" → "research X".
  t = t.replace(
    /^(hey\s+\w+,?\s*)?(can|could|would|will|please|pls|i(?:'| a)?\s*(?:need|want|'?d like)\s+(?:you\s+)?to|help me|let'?s|i'?d like you to)\b[\s,]*/i,
    "",
  );
  t = t.replace(/^(you\s+to|you|to)\s+/i, "");
  t = t.trim().replace(/[?.!]+$/, "");
  if (!t) t = (ask || "").trim();
  if (t.length > 120) t = t.slice(0, 117).trimEnd() + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

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

  // ---- A: confirm-intent capture (WIP gate). When the user REPLIES in a 1:1 DM that has a task at
  // confirm_status='asked' for that agent, this message IS the confirmation response. The reply turn
  // historically carried NO confirm context, so the agent just acknowledged and the task froze in
  // UP_NEXT. Fix, both fully guarded (a failure degrades to prior behavior, never breaks the turn):
  //   (1) record the confirmation DETERMINISTICALLY for a clear yes/refinement (not model-dependent);
  //   (2) hand the responding agent a directive (below, in its scene) to lock the DoD if not already
  //       AND call propose_approach — so the task actually advances, not just records the DoD.
  let pendingConfirm: {
    taskId: string;
    title: string;
    proposedDod: string | null;
    agentId: AgentId;
  } | null = null;
  try {
    const dmAgent =
      typeof data.huddleId === "string" && data.huddleId.startsWith("dm-")
        ? (data.huddleId.slice(3) as AgentId)
        : null;
    const replyText = (data.text ?? "").trim();
    if (dmAgent && AGENT_BY_ID[dmAgent] && replyText && !data.internal && !resume) {
      const em =
        (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
        data.caller?.entra_email ??
        null;
      if (em) {
        const { getPendingConfirmForAgent } = await import("./tasks/tasks.server");
        const pc = await getPendingConfirmForAgent(em, dmAgent);
        if (pc) {
          pendingConfirm = { ...pc, agentId: dmAgent };
          if (isPlainConfirmation(replyText)) {
            const dod = (pc.proposedDod ?? replyText).trim() || replyText;
            try {
              const { confirmTaskIntent } = await import("./tasks/tasks.server");
              await confirmTaskIntent(pc.taskId, em, dod);
              try {
                const { invokeJourneyTool } = await import("./journey/proxy.functions");
                await invokeJourneyTool({
                  toolName: "update_task",
                  args: { task_id: pc.taskId, definition_of_done: dod },
                  caller: data.caller ?? {},
                  context: { source: "huddle" },
                });
              } catch {
                /* journey mirror sync is best-effort */
              }
            } catch {
              /* deterministic capture is best-effort */
            }
          }
        }
      }
    }
  } catch {
    pendingConfirm = null;
  }

  // ---- B: chat-driven UNBLOCK. A blocked task can only be moved out of Blocked by its OWNING agent.
  //   (1) In the OWNER's own DM: hand the owner a directive to flip it via update_task — and NEVER claim
  //       it's unblocked unless that call actually succeeds (the core anti-false-positive).
  //   (2) In a NON-owner's DM (e.g. Terry, who surfaced the blocker): a clearance reply is ROUTED to each
  //       owner (real durable turn in dm-<owner>). One blocked task → route it; an explicit "all" → route
  //       each; an ambiguous "unblock it" with several blocked → ASK which, never guess/flip.
  // Fully guarded; any failure degrades to a no-op. (Blocked tasks are excluded from the confirm path in
  // block A, so an unblock reply can't be mis-handled as a confirmation.)
  let unblockReplyDirective = "";
  try {
    const dmAgent =
      typeof data.huddleId === "string" && data.huddleId.startsWith("dm-")
        ? (data.huddleId.slice(3) as AgentId)
        : null;
    const replyText = (data.text ?? "").trim();
    if (dmAgent && AGENT_BY_ID[dmAgent] && replyText && !data.internal && !resume) {
      const em =
        (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
        data.caller?.entra_email ??
        null;
      if (em) {
        const { getBlockedTasks } = await import("./tasks/tasks.server");
        const blocked = (await getBlockedTasks(em)).filter((t) => t.assignedAgent);
        if (blocked.length) {
          const mine = blocked.filter((t) => t.assignedAgent === dmAgent);
          const others = blocked.filter((t) => t.assignedAgent !== dmAgent);
          if (mine.length) {
            const list = mine
              .map((t) => `"${t.title}" (task_id ${t.taskId}; blocked because: ${t.reason})`)
              .join("; ");
            unblockReplyDirective =
              `\n\nIMPORTANT — you currently have BLOCKED task(s): ${list}. If the user's message clears a ` +
              `blocker (says it's resolved / go ahead / you're cleared / proceed), call update_task with the ` +
              `matching task_id (use it VERBATIM) and status "UP_NEXT" to move it out of Blocked — ACTUALLY ` +
              `call the tool. Tell the user it's unblocked ONLY if that call SUCCEEDS; never claim it ` +
              `otherwise. If they are NOT clearing it, don't change the status — just help.`;
          }
          if (others.length && looksLikeUnblock(replyText)) {
            const wantsAll = /\b(all|everything|both|each|every one|them all)\b/.test(replyText.toLowerCase());
            const toRoute = wantsAll ? others : others.length === 1 ? others : [];
            if (toRoute.length) {
              for (const t of toRoute) {
                void routeUnblockToOwner(t.assignedAgent as AgentId, t, replyText);
              }
              const names = [...new Set(toRoute.map((t) => AGENT_BY_ID[t.assignedAgent as AgentId]?.name ?? "the owner"))].join(", ");
              unblockReplyDirective +=
                `\n\nThe user is clearing a blocker on a teammate's task — you can't change another agent's ` +
                `task. Tell them briefly you've passed it to ${names} to move it out of Blocked. Do NOT call ` +
                `update_task yourself and do NOT claim anything is unblocked.`;
            } else {
              const listed = others
                .map((t) => `"${t.title}" (${AGENT_BY_ID[t.assignedAgent as AgentId]?.name ?? "unassigned"})`)
                .join(", ");
              unblockReplyDirective +=
                `\n\nThe user wants to clear a blocker but more than one task is blocked: ${listed}. Ask them ` +
                `WHICH one to unblock — do not change any task's status yet and do not claim anything is unblocked.`;
            }
          }
        }
      }
    }
  } catch {
    unblockReplyDirective = "";
  }
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
      ? '- The CURRENT DATE, TIME, and DAY are GIVEN to you in CONTEXT below and are authoritative — answer "today", "the date", "what day is it", "the time", "this week" DIRECTLY from that CONTEXT. Do NOT web-search for the date/time; you already have it. For OTHER time-sensitive or verifiable facts you do NOT already have — external "latest"/"current" info, a version or release number, a price, a score, standings, recent news, who currently holds a role, a public link — you MUST call the `tavily_web_search` tool and answer ONLY from its results; never guess those from memory.'
      : "- The CURRENT DATE, TIME, and DAY are given to you in CONTEXT below — answer date/time questions directly from it. You do NOT have a web-search tool this turn, so for OTHER verifiable facts (prices, versions, standings, recent news), say plainly you can't verify it right now rather than guessing.";
    return (
      "\n\nKNOWLEDGE AND FRESHNESS\n" +
      "- Your training data has a fixed cutoff. You do NOT inherently know the current date, time, prices, product versions, releases, standings, or news — these change after your cutoff.\n" +
      "- Trust the CONTEXT below over your own assumptions; never compute or guess the current date.\n" +
      freshness +
      "\n- Never state a specific version, price, or standing you did not just retrieve from a tool. (The current date/time is the ONE exception — it is given to you in CONTEXT below, so state it directly.)\n\n" +
      "CONTEXT\n" +
      (localNow
        ? `- Current date and time (the user's local time): ${localNow}\n` +
          `- Same instant in UTC (ISO 8601): ${nowIso}\n` +
          '- When the user asks for "today", "the date", or the time, use their LOCAL time above, not UTC.'
        : `- Current date and time (UTC, ISO 8601): ${nowIso}`)
    );
  }

  type Reply = {
    agentId: AgentId;
    text: string;
    fallbackNotes?: string[];
    // Artifacts this reply produced (create_artifact) so the chat bubble can render a clickable
    // "Open <name>" chip that opens the doc by id (fresh SAS on open). Derived from the agent's
    // toolUses at merge time — see the reply-push site.
    artifacts?: { id: string; name: string }[];
    // A confirm-intent ask this reply IS, carrying the proposed DoD for the button row below the
    // message. Derived the same way as artifacts — from this agent's own propose_task_intent
    // toolUse this turn — NOT injected from another turn/agent.
    confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
  };

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
    model: "gpt-5.6-luna",
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

  // A ceremony kickoff turn carries a SCRIPTED trigger phrase as `data.text` ("let's run the daily
  // stand-up") — not a real user utterance — and is the only turn that sets `router.ceremonyMode`.
  // Persisting it to rag_chunks polluted memory as if the user had said it, so skip the memory write
  // for ceremony triggers. (The agent replies are still persisted normally on their own turns.)
  const isCeremonyTrigger = !!routerCfg.ceremonyMode;

  // Skip on a resumed chunk — the user message was already persisted to memory on the first chunk;
  // re-writing it every continuation would duplicate the global chunk.
  if (!resume && !isCeremonyTrigger && (anyShared || privateAgents.length > 0) && openaiKey) {
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

        // "researched" mode captures the user's durable facts more aggressively (the narrow heuristic
        // misses "budget is $10k" / "drop Cobalt") and marks them supersede:true so a changed fact hides
        // the stale one. Legacy modes keep the heuristic gate + plain (non-superseding) writes, unchanged.
        const researchedMem = data.memoryMode === "researched";
        if (writes.length > 0 && (researchedMem || shouldExtractTriples(data.text))) {
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
                  supersede: researchedMem,
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
  // A ceremony barge no longer force-pins a target and skips the router. It flows through the SAME
  // router (routeMessageLLM / routeMessage), which runs the deterministic barge quick-route FIRST
  // (named agent → @mention → interlocutor, no LLM) and only falls to the semantic route when
  // nothing resolves. `data.targetAgentId` on a barge carries the INTERLOCUTOR (who held the floor),
  // passed to the router as `interlocutorId` — the authoritative name pick is now the router's.
  const isBarge = !!data.ceremonyBarge;
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
    // A ceremony barge routes through the LLM path too (scope is "group"); its `targetAgentId` is the
    // interlocutor, not a hard 1:1 target, so it must NOT disqualify LLM routing the way a real 1:1
    // target does. The barge quick-route inside the router resolves the winner deterministically before
    // any LLM call anyway — the LLM only runs if a barge names nobody and has no interlocutor.
    const canLLMRoute =
      data.scope === "group" &&
      (isBarge || !data.targetAgentId) &&
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
          // On a barge, targetAgentId is the interlocutor, not a hard target → pass it as such.
          targetAgentId: isBarge ? undefined : data.targetAgentId,
          ceremonyBarge: isBarge,
          interlocutorId: isBarge ? data.targetAgentId : undefined,
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
        targetAgentId: isBarge ? undefined : data.targetAgentId,
        ceremonyBarge: isBarge,
        interlocutorId: isBarge ? data.targetAgentId : undefined,
      });
    }
  } // end !resume routing

  // Difficulty backfill: routeMessageLLM only runs for GROUP turns, so 1:1 DMs (and any group turn that
  // fell to keyword routing) carry no `difficulty`. Deep asks happen in DMs too, so score it here with a
  // cheap dedicated LLM call — this is what powers the difficulty-driven model tier + the Sol confirm
  // gate in 1:1. LLM-primary (dynamic, no keyword list), heuristic fallback only when there's no key.
  // Guarded: any failure leaves difficulty unset (treated as 2 = standard downstream).
  if (!resume && routed.difficulty == null && !data.internal && !data.ceremonyBarge) {
    try {
      if (routerCfg.backend === "openai" && openaiKey) {
        const d = await scoreDifficultyLLM(data.text, {
          backend: "openai",
          model: routerCfg.model,
          fastMode: routerCfg.fastMode,
        });
        if (d != null) routed.difficulty = d;
      }
    } catch {
      /* leave unset — downstream treats undefined as 2 */
    }
    if (routed.difficulty == null) {
      // Heuristic fallback (never the sole authority — only when the LLM scorer is unavailable).
      const tt = classifyTaskType(data.text);
      routed.difficulty =
        tt === "deep_strategy" || tt === "research"
          ? 3
          : tt === "ack" || tt === "read" || tt === "crud" || tt === "recall"
            ? 1
            : 2;
    }
  }

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

  // Turn-level memoized caller-email resolve — several independent spots (ceremony detection,
  // resolveExecContext) used to each call resolveTaskEmail themselves, paying that round-trip
  // twice per turn. One resolve, shared.
  let resolvedCallerEmail: string | null | undefined;
  const resolveCallerEmail = async (): Promise<string | null> => {
    if (resolvedCallerEmail !== undefined) return resolvedCallerEmail;
    const { resolveTaskEmail } = await import("./journey/identity");
    resolvedCallerEmail =
      (await resolveTaskEmail(data.caller ?? {})) ?? data.caller?.entra_email ?? null;
    return resolvedCallerEmail;
  };

  // ACT-45: resolve this turn's chat attachments (ids only in the payload) into model-visible content —
  // ONCE per turn, memoized, and shared across every responding agent. Images become Responses
  // `input_image` parts (a fresh 15-min read SAS the model fetches); text files (.ics/.txt/.csv/.md/json)
  // are inlined; other binaries (pdf/office) are acknowledged by name (a full parse is a follow-on).
  // Fully fail-safe: any miss (no email, wrong owner, storage/DB error) yields empty → the turn falls
  // back to plain text, exactly as before.
  type AttachImagePart = { type: "input_image"; image_url: string };
  let attachmentContentPromise:
    | Promise<{ imageParts: AttachImagePart[]; inlineText: string }>
    | null = null;
  const resolveAttachmentContent = (): Promise<{ imageParts: AttachImagePart[]; inlineText: string }> => {
    if (attachmentContentPromise) return attachmentContentPromise;
    attachmentContentPromise = (async () => {
      const empty = { imageParts: [] as AttachImagePart[], inlineText: "" };
      const atts = data.attachments ?? [];
      if (atts.length === 0) return empty;
      try {
        const email = await resolveCallerEmail();
        if (!email) return empty;
        const { getArtifact } = await import("./artifacts/artifacts.server");
        const imageParts: AttachImagePart[] = [];
        let inlineText = "";
        for (const a of atts) {
          const row = await getArtifact(email, a.id); // email-scoped → wrong owner = null (no leak)
          if (!row) continue;
          if (row.mime.startsWith("image/") && row.url) {
            imageParts.push({ type: "input_image", image_url: row.url });
          } else if (row.text && row.text.trim()) {
            inlineText += `\n\n[Attached file — ${row.name}]\n${row.text}`;
          } else {
            inlineText += `\n\n[The user attached a file "${row.name}" (${row.mime}). Its contents aren't readable inline yet — acknowledge it and ask for the key details if you need them.]`;
          }
        }
        return { imageParts, inlineText };
      } catch {
        return empty;
      }
    })();
    return attachmentContentPromise;
  };

  // A2 ledger (researched mode, ALL scopes so it bridges huddles): keep the user's tracked facts & LISTS
  // current from THIS user message — the piece that makes a delta-edited list ("drop Cobalt, add Delta")
  // resolve to the complete latest set, which triples can't. Fire-and-forget: the reply is unaffected and
  // any failure is swallowed. Skipped on ceremony triggers / resumed chunks / internal back-channel turns.
  if (
    data.memoryMode === "researched" &&
    !isCeremonyTrigger &&
    !resume &&
    !data.internal &&
    !!data.text?.trim()
  ) {
    (async () => {
      try {
        const email = await resolveCallerEmail();
        if (!email) return;
        const { updateLedgerFromTurn } = await import("./rag/ledger-store.server");
        await updateLedgerFromTurn({ userEmail: email, userText: data.text });
      } catch (e) {
        console.error("[ledger] update failed", e instanceof Error ? e.message : e);
      }
    })();
  }

  // Ceremony tool-call tracking. When the client passes a ceremonyRunId (a live stand-up/barge turn),
  // persist every tool invocation to chat.ceremony_transcript (kind='tool') so "said it vs did it" is
  // provable after the run — the exact gap behind "the agent said it parked but it didn't stick".
  // Fire-and-forget: never blocks or breaks the turn. Email is pre-resolved because recordToolUse is
  // synchronous; resolved only when a run is actually present.
  const ceremonyToolRunId = data.ceremonyRunId ?? null;
  const ceremonyToolEmail = ceremonyToolRunId ? await resolveCallerEmail() : null;
  const trackCeremonyTool = (
    agentId: AgentId,
    tool: string,
    ok: boolean,
    summary?: string,
    errorDetail?: string,
    args?: unknown,
  ) => {
    if (!ceremonyToolRunId || !ceremonyToolEmail) return;
    void import("./ceremony/ceremony-transcript.server")
      .then((m) =>
        m.appendCeremonyToolCall(ceremonyToolEmail, ceremonyToolRunId, data.huddleId, {
          agentId,
          toolName: tool,
          ok,
          error: ok ? null : (errorDetail ?? summary ?? null), // the REAL tool error, not the summary
          summary: summary ?? null,
          args, // what the tool was actually called with — the key debug signal
          ts: Date.now(),
        }),
      )
      .catch(() => {});
  };
  // E (F13) — tool-lifecycle START marker. Persisted the instant a tool BEGINS executing (not at its
  // end, like trackCeremonyTool) so the client narration driver can voice an HONEST, event-driven cue
  // ("running a search…") keyed to a tool that is actually running now — never on a timer/guess.
  // Fire-and-forget; no-op outside a ceremony/barge run (no ceremonyRunId).
  const trackCeremonyToolStart = (agentId: AgentId, tool: string) => {
    if (!ceremonyToolRunId || !ceremonyToolEmail) return;
    void import("./ceremony/ceremony-transcript.server")
      .then((m) =>
        m.appendCeremonyToolStart(ceremonyToolEmail, ceremonyToolRunId, data.huddleId, {
          agentId,
          toolName: tool,
          ts: Date.now(),
        }),
      )
      .catch(() => {});
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
  // Pending host CLOSE turn (set when a round-robin is built; survives chunk boundaries via progress).
  let ceremonyCloser: [AgentId, string] | null = resume?.ceremonyCloser ?? null;
  // Transient per-dispatch directive for a barge-in responder. NOT persisted (cleared right after
  // the dispatch); takes precedence over the standing ceremony directive in the scene builder.
  const bargeDirectiveById = new Map<AgentId, string>();
  // Synchronous client barge (runBargeSequence): the whole group turn IS a live-ceremony interjection,
  // so whichever agent the router picks answers it with the barge directive layered on (same
  // bargeDirective() the durable ceremony path uses). Applies to every responder this turn since the
  // client only voices the primary; the standing per-agent maps above stay empty on this path.
  const turnBargeDirective =
    data.ceremonyBarge && data.scope === "group" ? bargeDirective(data.text) : "";
  // A ceremony BARGE gets no round-robin report (ceremonyType is forced null below), so the responder
  // otherwise has ZERO task data to answer "which task is completed?" or resolve "that consulting-app
  // piece" — only a truncated, interruption-lossy transcript. Build the authoritative board ONCE and
  // inject its NAME-level digest into the responder's scene so it can name the real task and act on it.
  // Best-effort: a DB hiccup must never block the barge answer. Standup window (the live-team ceremony).
  // Short-term memory mechanism (Settings → Memory). Only "reconstruction" is implemented (the app-
  // managed transcript + the unconditional self-recall block injected per responder below). The other
  // two are SCAFFOLD — they carry through the payload but behave as reconstruction; log a marker so a
  // live run makes it obvious which mode ran (no OpenAI previous_response_id/Conversations plumbing yet).
  const memoryMode = data.memoryMode ?? "reconstruction";
  // "conversation" IS implemented for 1:1 DMs (OpenAI Conversations object per agent+huddle, wired
  // at the persona call site below); group turns fall back to reconstruction by design. Only
  // "responses-chain" remains an unimplemented scaffold.
  if (memoryMode === "responses-chain") {
    console.warn(
      `[huddle-memory] memoryMode="responses-chain" is not yet implemented — using "reconstruction". No OpenAI-native state was used this turn.`,
    );
  }

  let ceremonyBoardBlock = "";
  if (turnBargeDirective) {
    try {
      const email = await resolveCallerEmail();
      if (email) {
        const { getStandupTasks } = await import("./tasks/tasks.server");
        const bTasks = await getStandupTasks(email, CEREMONY_WINDOW_HOURS.standup);
        const bReport = buildCeremonyReport("standup", bTasks);
        const digest = boardDigestNamed(bReport);
        ceremonyBoardBlock = `\n\nTHE STAND-UP BOARD — the user's REAL current tasks this stand-up covers. This is your SOURCE OF TRUTH, more authoritative than the transcript. Answer "which task is done / what's blocked / what's in review" by NAMING the specific task from here. Resolve "that" / "it" / "that one" / "that piece" to the specific named task here — do NOT ask the user which task when it is listed below, and NEVER claim you can't find a task that appears here. To change a task's status (park it, move to backlog, mark done), call update_task for that task by its title.\n${digest}`;
      }
    } catch {
      /* best-effort — never block the barge answer on a task-load hiccup */
    }
  }
  // A synchronous barge is ALWAYS a normally-routed answer to a live interjection — never a nested
  // ceremony. Skip detection so a barge whose text happens to look like a ceremony trigger can't
  // re-enter the round-robin machinery; it goes straight to routeMessageLLM + the barge directive.
  const ceremonyType = resume || turnBargeDirective ? null : detectCeremony(data.text);
  if (ceremonyType) {
    // Resolve the sign-in email (possibly an alias) to the canonical journey email the mirror
    // is keyed on — otherwise an aliased login grounds the ceremony in an empty task set.
    const email = await resolveCallerEmail();
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

      // F9 — participant set is derived ONCE here (shared roundRobinParticipants) so who speaks is the
      // ONLY source of who is dispatched (AC-F10.3). speakingOwners drops truly-nothing owners (and, for a
      // stand-up, done-only owners). No owner with live work → the host narrates solo (degenerate case),
      // never an invented owner.
      const participants = roundRobinParticipants(report, data.members);
      const speakingOwners = participants.filter((p) => p !== CEREMONY_HOST);

      if (narrate || speakingOwners.length === 0) {
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
        const owners = lanesByOwner(report);
        // Owners in speaking order → Terry names them in his opener hand-off ("Tess, you're up; then Finn").
        const handoffNames = participants
          .filter((p) => p !== CEREMONY_HOST)
          .map((p) => AGENT_BY_ID[p]?.name ?? p);
        for (const p of participants) {
          // Host OPENS the ceremony (first in `participants`); lane owners then give their updates.
          if (p === CEREMONY_HOST)
            ceremonyDirectiveById.set(p, openerDirective(ceremonyType, report, handoffNames));
          else {
            const lane = owners.get(p);
            if (lane) ceremonyDirectiveById.set(p, ownerDirective(ceremonyType, lane));
          }
        }
        // Arm Terry's CLOSING turn: after every owner has spoken, the host speaks once more to
        // synthesize and surface blockers. Only when the host is present AND at least one owner
        // spoke (participants = [host, ...owners], so length > 1). Runs as a post-loop step so the
        // host isn't duplicated in the queue (the spoken-guard would skip a repeat there anyway).
        if (data.members.includes(CEREMONY_HOST) && participants.length > 1) {
          ceremonyCloser = [CEREMONY_HOST, closerDirective(ceremonyType, report)];
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

  // ---- Deep-1:1 PRODUCE-vs-QUICK confirm gate + manual escalation (1:1 only) ----------------------
  // A fresh 1:1 ask the router scores DEEP (difficulty ≥3) is rarely something to answer as a long,
  // high-effort SYNCHRONOUS chat wall — it's usually a PRODUCE request (research/draft/plan) whose real
  // home is the async WIP pipeline (a board task the team works up → an artifact you review). So instead
  // of silently spending the deep reasoning model (o3) inline, the runtime HOLDS and asks the user which
  // shape they want: produce it async, or just a quick take right here? The pending ask is stored
  // cross-turn; the reply resumes on the chosen shape:
  //   • produce → create a real board task + kick the async auto-work pipeline; ack (no inline deep spend)
  //   • quick   → resume the ORIGINAL ask INLINE on a chat-friendly tier (Terra-med), never the o3 rung
  //   • cancel  → drop it
  // A manual override (data.modelEscalate) skips the gate; group turns, internal turns, ceremonies, and
  // resumes never gate. Best-effort: any store error just proceeds normally (no gate) so a turn never
  // breaks. `deepManual` is read again at the persona site to pick the model/effort.
  let deepManual: string | undefined = data.modelEscalate?.trim() || undefined;
  if (!resume && !data.internal && !data.ceremonyBarge && data.scope === "one-to-one") {
    try {
      const email = await resolveCallerEmail();
      const {
        getPendingDeepConfirm,
        setPendingDeepConfirm,
        clearPendingDeepConfirm,
        classifyConfirmReply,
      } = await import("./tasks/deep-confirm.server");

      const pending = await getPendingDeepConfirm(email, data.huddleId);
      if (pending) {
        const verdict = classifyConfirmReply(data.text);
        if (verdict === "quick") {
          // Resume the original ask inline on a chat-friendly tier — deliberately NOT the deep o3 rung.
          // Manual override wins in resolveByDifficulty (no re-gate); force difficulty to standard so
          // central tracking records the turn as the chat-shaped turn it actually is.
          deepManual = "terra-med";
          data.text = pending.askText;
          routed.difficulty = 2;
          if (pending.agentId && data.members.includes(pending.agentId as AgentId)) {
            routed.winners = [pending.agentId as AgentId];
            routed.interjectors = [];
          }
          await clearPendingDeepConfirm(email, data.huddleId);
        } else if (verdict === "produce") {
          await clearPendingDeepConfirm(email, data.huddleId);
          const agentId = (pending.agentId as AgentId) ?? routed.winners[0] ?? data.members[0];
          const title = produceTitleFrom(pending.askText);
          // Create the produce task on the board (dual-write to journey). Non-fatal.
          let created = false;
          try {
            if (data.caller?.entra_email) {
              const { invokeJourneyTool } = await import("./journey/proxy.functions");
              const r = await invokeJourneyTool({
                toolName: "quick_create_task",
                args: { title },
                caller: data.caller ?? {},
                context: { source: "huddle", huddleId: data.huddleId, agentId },
              });
              created = !!r.ok;
              if (r.ok && r.tasks && r.tasks.length > 0) journeyTaskUpdates.push(...r.tasks);
            }
          } catch (e) {
            console.warn(
              `[huddle-model] produce-confirm task create failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          // Kick the async WIP pipeline (fire-and-forget; the gated 9/13/17 cadence also picks it up).
          try {
            const { runScheduledAutoWork } = await import("./tasks/autowork.server");
            void runScheduledAutoWork(data.caller, { force: true }).catch(() => {});
          } catch {
            /* best-effort */
          }
          return finalize({
            decision: {
              ...routed.decision,
              reason: `${routed.decision.reason} [deep-confirm: produce]`.slice(0, 220),
            },
            replies: [
              {
                agentId,
                text: created
                  ? `Done — I've put “${title}” on the board as a produce task and kicked it to the team to work up async. You'll get the draft to review. Want me to steer it any particular way?`
                  : `I'll take “${title}” on as a produce task and work it up async — you'll get the draft to review. (Heads up: I couldn't confirm the board write just now, so give it a quick check.)`,
              },
            ] as Reply[],
            fallbacks,
            prompts,
            journeyTaskUpdates,
            suggestedTasks,
            toolUses,
            reasoning: reasoningSummaries,
          });
        } else if (verdict === "cancel") {
          await clearPendingDeepConfirm(email, data.huddleId);
          return finalize({
            decision: routed.decision,
            replies: [
              {
                agentId: (pending.agentId as AgentId) ?? routed.winners[0] ?? data.members[0],
                text: "No problem — I'll hold off. Say the word whenever you want me to pick it back up.",
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
        // verdict "unrelated" → leave the pending (2h expiry) and fall through to normal routing.
      }

      // Fresh deep ask (no manual override): HOLD and ask produce-vs-quick instead of spending o3 inline.
      if (!deepManual && routed.winners.length > 0 && (routed.difficulty ?? 2) >= 3) {
        const primary = routed.winners[0];
        await setPendingDeepConfirm(email, data.huddleId, primary, data.text);
        return finalize({
          decision: {
            ...routed.decision,
            reason: `${routed.decision.reason} [deep-confirm: produce-vs-quick]`.slice(0, 220),
          },
          replies: [
            {
              agentId: primary,
              text:
                "That's a meaty one. Want me to **produce** it — take it on as a task, do the deep work async, and hand you a draft to review — " +
                'or would a **quick take right here** do for now? Reply "produce", "quick", or "cancel".',
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
    } catch (err) {
      console.warn(
        `[huddle-model] deep-confirm gate error: ${err instanceof Error ? err.message : String(err)}; proceeding without gate.`,
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
  const queue: AgentId[] = resume
    ? [...resume.remainingQueue]
    : [...routed.winners, ...interjectorSet];
  const spoken = new Set<AgentId>(resume?.spoken ?? []);
  const replies: Reply[] = resume ? [...resume.replies] : [];

  // A ceremony barge is voiced by the client from `replies[0]` ONLY, but the server would otherwise
  // run every routed winner + interjector — each executing its own tools redundantly (iris/elle/eli
  // all running the same lookup). `soloOnCoverage` does not reliably cut to one. So pin a fresh barge
  // turn to exactly ONE responder: the router's first winner (the addressed/primary agent — the LLM
  // router already honors a barge addressed by name), dropping the rest and all interjectors. Only the
  // client capping the voice can't stop the server-side tool runs, so this must happen here.
  if (turnBargeDirective && !resume && queue.length > 1) {
    const primary = queue[0];
    queue.length = 0;
    queue.push(primary);
    interjectorSet.clear();
  }

  // Embedding of the user's message for AUTO memory retrieval, computed at most once per turn
  // (undefined = not yet computed, null = embedding failed). Recall must not depend on the model
  // electing to call `search_memory`: we proactively pull the most relevant SHARED/global memory
  // into each responding agent's prompt. This is what carries context across huddles (e.g. a fact
  // stated in the group channel is available in a later 1:1) without the agent having to ask.
  let memoryQueryVec: number[] | null | undefined;
  // Turn-level cache of the Executive Profile block (same for all agents this turn; resolved once,
  // email-scoped). "" when no profile is set → zero prompt overhead. Appended alongside OPERATING_CONTRACT.
  let execContextBlock: string | undefined;
  const resolveExecContext = async (): Promise<string> => {
    if (execContextBlock !== undefined) return execContextBlock;
    execContextBlock = "";
    try {
      const em = await resolveCallerEmail();
      if (em) {
        const { getUserContext, renderExecutiveContext } =
          await import("./identity/user-context.server");
        execContextBlock = renderExecutiveContext(await getUserContext(em));
      }
    } catch {
      execContextBlock = "";
    }
    return execContextBlock;
  };

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
  async function deliverOwnerFollowup(
    ownerId: AgentId,
    fromName: string,
    ask: string,
  ): Promise<void> {
    try {
      const owner = AGENT_BY_ID[ownerId];
      if (!owner) return; // caller already guards ownerId !== the deferring agent
      const cleanAsk = ask.replace(/\s+/g, " ").trim().slice(0, 240);
      const ownerHuddle = `dm-${ownerId}`;
      // Store under the CANONICAL journey email — the same value the client's cross-huddle back-fill
      // (getAllTurnUpdates → getUserTurnsSince) queries with. The raw sign-in `entra_email` can differ
      // from the resolved email (e.g. Von.Ellis@EnterpriseDS.io → dev@enterpriseds.io); keying the row
      // under the raw login left the finished follow-up unmatchable by the back-fill, so its push fired
      // but the message never rendered in the owner's DM. Mirrors enqueueHuddleTurn's resolution.
      let email: string | null = null;
      try {
        const { resolveTaskEmail } = await import("./journey/identity");
        email = (await resolveTaskEmail(data.caller)) ?? data.caller?.entra_email ?? null;
      } catch {
        email = data.caller?.entra_email ?? null;
      }
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
      const id = `followup-${data.huddleId}-${ownerId}-${cleanAsk
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)}`;
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
        internal: true, // CRUCIAL: a follow-up must never spawn another follow-up (kills the loop)
      };
      const { enqueueTurn } = await import("./tasks/turns.server");
      const fresh = await enqueueTurn(id, ownerHuddle, email, followupPayload);
      if (fresh) void kickNextChunk(id); // run it now; the pg_cron drain backstops a lost kick
    } catch {
      /* follow-up delivery is best-effort — never fail the user's turn on it */
    }
  }

  // Chat-driven UNBLOCK routing: the user cleared a blocker while talking to a NON-owner (e.g. Terry,
  // who surfaced it) — only the OWNING agent can move its task out of Blocked. Enqueue a REAL durable
  // turn in the owner's own DM. Unlike deliverOwnerFollowup (which defers and re-asks for confirmation),
  // the user ALREADY authorized this, so the instruction — carried in the turn TEXT because the turn is
  // internal:true (a scene directive would be `!data.internal`-gated and never reach it) — tells the
  // owner to call update_task NOW, with the EXACT task_id. Task-scoped id so distinct tasks never collapse.
  async function routeUnblockToOwner(
    ownerId: AgentId,
    task: { taskId: string; title: string; reason: string },
    userSay: string,
  ): Promise<void> {
    try {
      const owner = AGENT_BY_ID[ownerId];
      if (!owner) return;
      // Canonical journey email (see deliverOwnerFollowup) so the finished unblock turn is matchable by
      // the client's cross-huddle back-fill — the raw login can resolve to a different address.
      let email: string | null = null;
      try {
        const { resolveTaskEmail } = await import("./journey/identity");
        email = (await resolveTaskEmail(data.caller)) ?? data.caller?.entra_email ?? null;
      } catch {
        email = data.caller?.entra_email ?? null;
      }
      const say = userSay.replace(/\s+/g, " ").trim().slice(0, 160);
      const ownerHuddle = `dm-${ownerId}`;
      const directive =
        `You are ${owner.name}. Your task "${task.title}" (task_id ${task.taskId}) is BLOCKED — reason: ` +
        `"${task.reason}". The user just cleared it: "${say}". If that resolves the blocker, call ` +
        `update_task NOW with task_id "${task.taskId}" (use that id VERBATIM — never the title) and ` +
        `status "UP_NEXT" to move it out of Blocked, then tell the user in ONE short line that it's ` +
        `unblocked and back in play — but ONLY if the update_task call SUCCEEDED. If it did not, say you ` +
        `could not clear it and ask them to confirm. If their message does NOT actually clear the blocker, ` +
        `don't change the status — just reply briefly.`;
      const id = `unblock-${task.taskId}`; // task-scoped — two distinct tasks never dedup to one turn
      const payload = {
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
        notify: "push",
        internal: true, // never spawns another follow-up
      };
      const { enqueueTurn } = await import("./tasks/turns.server");
      const fresh = await enqueueTurn(id, ownerHuddle, email, payload);
      if (fresh) void kickNextChunk(id);
    } catch {
      /* best-effort — never fail the user's turn on it */
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
  const handoffById = new Map<AgentId, { fromName: string; ask: string }>(
    resume?.handoffById ?? [],
  );

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
      // `timedOut` distinguishes a runBounded deadline race (retry with fresh budget next chunk)
      // from a completed call that genuinely produced no text (retrying would just repeat it).
      | { kind: "skip"; timedOut?: boolean }
      | { kind: "hardReply"; reply: Reply }
      | { kind: "reply"; clean: string; isInterjector: boolean; perAgentFallbacks: string[] };
  };
  const runAgentTurn = async (
    nextId: AgentId,
    priorInThisTurn: string,
    // For a BARGE-IN dispatch, the agent must answer the user's interjection — not the standing
    // ceremony trigger ("let's run the daily stand-up"). Override the user message (and the
    // force-tool regexes) with the barge text so the reply addresses what the user actually asked.
    userTextOverride?: string,
    // Tied to runBounded's own per-agent deadline (below). Without this, a timed-out attempt is only
    // stopped being WAITED ON, not actually stopped — the model/tool-call loop keeps running in the
    // background and can still fire real, un-tracked tool calls after the turn has already finalized
    // without it, which a later retry then discovers and misreports as pre-existing. Threaded into
    // both model backends so neither can zombie.
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> => {
    const winner = AGENT_BY_ID[nextId]!;
    const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };
    const userText = userTextOverride ?? data.text;

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
      args?: unknown,
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
      // Durably record this tool call against the ceremony run (no-op outside a ceremony) — the real
      // error + the args are what make a failure debuggable.
      trackCeremonyTool(agentId, tool, ok, summary, detail, args);
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

    // Pillar 2 — delegate_to_specialist dispatch (shared by BOTH the OpenAI and Lovable tool paths,
    // mirroring create_artifact). It ENQUEUES a durable worker sub-turn per delegation and returns
    // immediately — the persona keeps talking ("I've put the team on it"); the worker runs off the
    // turn deadline and, when the last one finishes, an integration turn brings the persona back to
    // synthesize (see runWorkerTurn). orchestrationId is per (turn, persona) so two personas in one
    // group turn each integrate their own workstreams; ids are idempotent so a resume never
    // double-dispatches. Only personas get this tool; a worker run never does (AC-5 — no nesting).
    let delegationSeq = 0;
    const dispatchDelegate = async (rawArgs: Record<string, unknown>): Promise<string> => {
      const roleArg = String(rawArgs.role ?? "").trim();
      const objective = String(rawArgs.objective ?? "").trim();
      const inputs = rawArgs.inputs != null ? String(rawArgs.inputs).trim() : undefined;
      const acceptance =
        rawArgs.acceptance_criteria != null
          ? String(rawArgs.acceptance_criteria).trim()
          : undefined;
      const worker = getWorker(roleArg);
      if (!worker)
        return JSON.stringify({
          ok: false,
          error: `unknown specialist role "${roleArg}"; choose one of: ${WORKER_ROLES.join(", ")}`,
        });
      if (!objective) return JSON.stringify({ ok: false, error: "objective is required" });
      const claimKey = `delegate:${worker.id}:${objective.toLowerCase().slice(0, 80)}`;
      if (!claimAction(claimKey)) {
        recordToolUse(
          winner.id,
          "delegate_to_specialist",
          `already delegated ${worker.role} this turn — skipped duplicate`,
          true,
        );
        return JSON.stringify({ ok: true, deduped: true, dispatched: worker.id });
      }
      try {
        const email =
          (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
          data.caller?.entra_email ??
          null;
        const orchestrationId = `orch-${turnId ?? data.huddleId}-${winner.id}`;
        const seq = delegationSeq++;
        const workerTurnId = `worker-${orchestrationId}-${worker.id}-${seq}`;
        const workerPayload = {
          worker: {
            role: worker.id,
            objective,
            inputs,
            acceptance_criteria: acceptance,
            personaId: winner.id,
            personaName: winner.name,
            orchestrationId,
            originHuddleId: data.huddleId,
            originScope: data.scope,
          },
          // Carried so the worker run resolves the same user + timezone as the persona, and so the
          // integration turn can rebuild a valid runHuddleTurn input.
          caller: data.caller,
          timeZone: data.timeZone,
          router: data.router,
          agents: data.agents,
          notify: "silent", // workers are internal — no push; only the integrated answer notifies.
        };
        const { enqueueTurn } = await import("./tasks/turns.server");
        const fresh = await enqueueTurn(workerTurnId, data.huddleId, email, workerPayload);
        if (fresh) void kickNextChunk(workerTurnId); // start now; cron drain backstops a lost kick
        recordToolUse(
          winner.id,
          "delegate_to_specialist",
          `tasked ${worker.role}: ${objective.slice(0, 80)}`,
          true,
        );
        return JSON.stringify({
          ok: true,
          dispatched: worker.id,
          role: worker.role,
          async: true,
          note: "The specialist is working now; you'll be brought back to integrate their findings when done. Tell the user you've put the team on it — do not fabricate results.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordToolUse(winner.id, "delegate_to_specialist", "delegation failed", false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }
    };

    // A barge-in directive (answering a live user interjection) takes precedence over the standing
    // ceremony directive for this one dispatch, so the agent addresses the user instead of its lane.
    const ceremonyDirective =
      bargeDirectiveById.get(nextId) ?? ceremonyDirectiveById.get(nextId) ?? turnBargeDirective;
    // SELF-RECALL (memoryMode "reconstruction" — the active default, UNCONDITIONAL on ceremony turns):
    // hand the responding agent its OWN prior remarks from THIS stand-up, verbatim. Huddle has no
    // OpenAI cross-turn native memory — an agent's short-term recall is only the reconstructed
    // transcript, which the voice/mp3 round-trip + role-tagging can make lossy, so an agent can go
    // blank on "what did you just say?" even 1–2 turns later. This guarantees it always sees its own
    // words. Empty (no header, no tokens) when the agent hasn't spoken yet this ceremony.
    let selfRecallBlock = "";
    if (ceremonyDirective) {
      const own = (data.history as HuddleMessage[])
        .filter(
          (m) =>
            m.author.kind === "agent" &&
            (m.author as { kind: "agent"; agentId: AgentId }).agentId === nextId,
        )
        .map((m) => m.text.trim())
        .filter(Boolean);
      if (own.length) {
        const lines = own
          .slice(-6)
          .map((tx) => `- "${tx}"`)
          .join("\n");
        selfRecallBlock = `\n\nYOUR OWN earlier remarks in THIS stand-up (you said these — recall them verbatim and NEVER contradict, disavow, or claim you don't remember them; if the user asks "what did you just say / which task", answer directly from this):\n${lines}`;
      }
    }
    // Ceremony cross-talk: a scheduled round-robin speaker sees the IMMEDIATELY-PRIOR speaker's line
    // so it can briefly react before its own update — a natural group conversation instead of
    // scripted monologues (the standing "do NOT comment on other lanes" gate is what made it feel
    // read-aloud). Only the prior speaker's single line (bounds prompt growth across a 12-agent
    // round-robin), and NOT on a barge dispatch (that answers the user, handled by bargeDirective).
    const isScheduledCeremonyTurn =
      !!ceremonyDirectiveById.get(nextId) && !bargeDirectiveById.get(nextId) && !turnBargeDirective;
    const ceremonyPriorReact =
      isScheduledCeremonyTurn && priorInThisTurn
        ? (() => {
            const lines = priorInThisTurn
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            const last = lines[lines.length - 1] ?? "";
            return last
              ? `\n\nThe teammate right before you just said — ${last}\nYou MAY open with ONE brief, natural line acknowledging or reacting to that, the way a real teammate would in the room, BEFORE giving your own update — but stay in YOUR lane's facts; don't take over or re-report theirs. If there's nothing worth reacting to, just give your update.`
              : "";
          })()
        : "";
    const handoff = handoffById.get(nextId);
    const handoffDirective = handoff
      ? `\n\nYou were brought into this turn by ${handoff.fromName}, who handed this to you: "${handoff.ask}". Address exactly that in your lane — answer it directly or take the action they need. Do not re-ask what was already said or restate their message.`
      : "";
    // Domain/theme lane hand-off (1:1 only — group turns already route to the right lane). If the
    // user's ask clearly belongs to another agent's lane (by domains/themes, e.g. "tighten my
    // budget" → Finn), tell THIS agent to defer and bring them in, even though that owner isn't in
    // the room. Deterministic + data-driven, so it covers every lane, not just the tool-owned ones.
    // Intent-gated: only fire when the user is actually requesting an action to be performed — not
    // when they are confirming completion, querying ownership, acknowledging, or informing.
    const turnIntent: TurnIntent = TURN_INTENT_CLASSIFICATION
      ? classifyTurnIntent(data.text)
      : "perform";
    let laneDirective = "";
    if (data.scope !== "group" && !data.internal && turnIntent === "perform") {
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

    // A: if the user is replying to THIS agent's pending confirm-intent ask, direct it to lock the DoD
    // and propose its approach — so the task advances out of Up Next. If the runtime already recorded a
    // plain "yes" above, confirm_task_intent is idempotent; propose_approach is what actually moves it.
    const confirmReplyDirective =
      pendingConfirm && pendingConfirm.agentId === winner.id
        ? `\n\nIMPORTANT — the user is replying to your earlier check-in that asked them to confirm the assumed action + Definition of Done for their task "${pendingConfirm.title}". This message is that reply. If they confirmed it (as-is or with tweaks), call confirm_task_intent NOW with task_id "${pendingConfirm.taskId}" and the FINAL definition_of_done (fold in any change they made) — actually call the tool, don't just acknowledge in prose. Then, in this SAME turn, call propose_approach for that task so it can move forward. If the reply instead shows the task genuinely CANNOT proceed (it needs a decision, a credential, or access the team lacks), call flag_blocker with that EXACT task_id "${pendingConfirm.taskId}" — use that id verbatim, NEVER the task's title or an invented id — and a specific reason. If they declined or are still deciding, don't call the tools — just help them decide.`
        : "";

    // Single capture-owner (group): exactly ONE agent — the lead/primary — captures the user's task
    // items, so nothing is DROPPED (the lead captures the whole list) and nothing is DUPLICATED (only
    // the lead files). Every other responder still contributes its lane expertise but files no cards for
    // the user's listed items. Keyed on the persisted primary (routed.decision.winnerId survives a
    // resumed/streamed turn, where routed.winners is intentionally emptied). 1:1 is unchanged. This
    // replaces the earlier "each agent files only its own lane" partition, which could DROP an item when
    // a lane's owner wasn't routed (e.g. a timed errand pulled to the calendar agent, then skipped).
    const leadId =
      routed.winners[0] ?? (routed.decision?.winnerId as AgentId | undefined) ?? undefined;
    let captureDirective = "";
    if (data.scope === "group" && !data.internal && leadId) {
      captureDirective =
        winner.id === leadId
          ? `\n\nTASK CAPTURE — you are the LEAD this turn. If the user's message lists things to tackle (a multi-item to-do / brain-dump, across one or more lanes), YOU capture EVERY item, across ALL lanes, with create_huddle_tasks in ONE call — never leave an item for a teammate to file and never assume someone else will. Capturing all of them so nothing is dropped is your job this turn; teammates add expertise, but you own the board capture.`
          : `\n\nTASK CAPTURE — you are NOT the lead this turn; the lead agent is capturing the user's to-do items onto the board. Contribute your lane's expertise, analysis, or a draft, but do NOT create task cards for the items the user listed — filing them again would duplicate the board. (Only if you have a genuinely NEW action item the user did not mention, and it is squarely in your lane, may you create that single one.)`;
    }

    const scene = ` You are ${winner.name} in a ${
      data.scope === "group" ? "group huddle" : "1:1"
    }. Reply naturally, as yourself, in-character — like you're talking in a room with real people. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to". Do not speak as anyone else. 1–3 short sentences unless asked for detail. Do NOT repeat a reply you already gave earlier in this conversation — your own past messages are in the history above; if you genuinely have nothing new since your last update, say that briefly (e.g. "same as before — nothing new on my end") instead of restating the same line word-for-word (that "broken record" repetition is a real failure to avoid).${
      priorInThisTurn && !ceremonyDirective
        ? `\n\nOther agents ALREADY replied in this same turn:\n${priorInThisTurn}\nDo NOT restate, re-answer, paraphrase, or agree with what they said — the user already read it. Contribute ONLY the distinct piece your own lane owns that they did not cover. If you have nothing to add beyond what's been said, reply with a single short sentence deferring to them (e.g. "nothing to add — @finn-reid covered it"). Never repeat another agent's answer back.`
        : ""
    }${interjectDirective}${ceremonyDirective}${selfRecallBlock}${ceremonyBoardBlock}${ceremonyPriorReact}${handoffDirective}${laneDirective}${captureDirective}${confirmReplyDirective}${
      data.huddleId === `dm-${winner.id}` ? unblockReplyDirective : ""
    }`;

    const roster = buildRoster(data.members, winner.id);
    // Data-driven, scope-aware ownership hand-off (agents.ts capabilities). Empty string
    // when no exclusive-capability owner is in this huddle, so zero prompt overhead then.
    // Intent-gated for 1:1: structural suppression is the only reliable mechanism — do not
    // send prose the LLM should not act on (qualifier text is applied against full history).
    //   "perform"     → full block (directory + deferral rule)
    //   "query"       → directory only, no rule (lets agent answer "who owns grooming?")
    //   status/ack/inform → "" (no ownership context needed to say "got it")
    // Group turns always receive the full block — @mention rule is relevant regardless of intent.
    let capabilityBlock: string;
    if (data.scope === "group" || data.internal || !TURN_INTENT_CLASSIFICATION) {
      capabilityBlock = capabilityHandoffBlock(
        data.scope === "group" ? "group" : "1:1",
        data.members,
        winner.id,
      );
    } else if (turnIntent === "perform") {
      capabilityBlock = capabilityHandoffBlock("1:1", data.members, winner.id);
    } else if (turnIntent === "query") {
      capabilityBlock = capabilityHandoffBlock("1:1", data.members, winner.id, false);
    } else {
      capabilityBlock = "";
    }
    const taskToolInstructions =
      "\n\nYou have a `create_huddle_task` tool. When the user asks to add, create, log, track, assign, capture, or put a task/action item on the board, call `create_huddle_task` before answering. It creates a suggested board card for user approval; do not merely say you will add it." +
      ' When the user asks for MORE THAN ONE task in a single message, call `create_huddle_tasks` (plural) ONCE with all of them in the `tasks` array — do NOT emit several `create_huddle_task` calls and do NOT create one and describe the rest as done. Its result reports `created` (the exact number created) plus `deferred`/`skipped`; state that exact count and mention anything skipped — e.g. "added 2 of the 3; the third is already on your board." Never say "created all of them" / "both" unless the `created` count actually equals what the user asked for.' +
      ' NEVER use it to create a task that merely restates an action you were asked to PERFORM (e.g. a card titled "groom the backlog" or "assign the team") — that is not a to-do, it is the thing you were asked to do: perform it, or hand it to the agent who can. Only create tasks for genuine future work the user wants tracked.' +
      " If the user states or implies a specific date (a day name, 'tomorrow', a calendar date, 'by Friday'), set the tool's `date` field — do not just leave it embedded in the title text where it can get lost." +
      ' Report the outcome honestly using exactly what the tool result gives you, in `note`/`outcome` — never invent a time or claim more certainty than that. A same-day scheduled time is provisional (the nightly planner can still move it overnight) — say something like "I\'ve got that for around 2:30 today" rather than a firm commitment. A task with a due date but no start_time has no exact time yet — say the due date and that the planner will place a time, don\'t guess one. If the outcome says today was full and it landed elsewhere, say so plainly instead of a bare "added it."' +
      ' CARD STATUS IS TRACKING, NOT EXECUTION. Updating a task\'s board status — marking it done, moving it to a lane (via `update_task`) — only changes the CARD; it does NOT perform, execute, or confirm the underlying real-world action (a payment, a money transfer, an errand, a message). When the user asks to mark a card done, just change the status — do NOT refuse, and do NOT demand proof that the real-world thing actually happened (e.g. "make sure the transfer was executed in your financial systems"); whether the real-world action occurred is the USER\'s call, not yours to gate. Confirm strictly in board terms ("marked that card done") and NEVER claim you performed the real-world action yourself.' +
      ' PARKING LOT: when the user asks to "parking lot" / "park" a task (or pause its automation), call `update_task` for that task with status:"BACKLOG" and its tags set to include "parking-lot" (preserve any existing tags — read them first if unsure). This moves it to Backlog and opts it OUT of all automated work (no promotion, no auto-research, no nightly scheduling) until the user un-parks it. Confirm you parked it. To un-park, call `update_task` with the "parking-lot" tag removed.' +
      " PROACTIVE PARKING (offer, never silently do it): if you notice a task that has been deferred many times (a high 'deferred N×' count) or has stayed blocked across multiple stand-ups, briefly OFFER to park it — e.g. \"'<title>' has been deferred 11× and keeps surfacing; want me to park it so it stops filling the stand-up and the work queue?\" — and only call `update_task` to park it AFTER the user agrees. This keeps chronically-stalled items from dominating every stand-up and the automation queue. Do NOT auto-park without the user's explicit confirmation, and do NOT open a card about parking it." +
      ' RESOLVE A NAMED TASK TO ITS ID FIRST. When the user refers to a task by NAME or description (not an id) and you need to act on it with a tool that takes a `task_id` (update_task, flag_blocker, confirm_task_intent, reschedule_task, schedule_task, etc.), FIRST call `get_tasks` with the `query` param set to the distinctive words of the title — e.g. `get_tasks{query:"competitor pricing"}` — to look it up. That search matches by title across ALL statuses (Backlog included), so use it before concluding a task does not exist. Then pass the EXACT id it returns, VERBATIM. NEVER pass a task\'s title, a slug, or a guessed value as the `task_id`, and never tell the user you could not find their task without having tried this title lookup first.';

    // AUTO memory retrieval: pull the most relevant shared/global memory for THIS agent and inject
    // it into the prompt, so recall works even when the model doesn't call `search_memory`. This is
    // the fix for "forgot two lines ago" across huddles — history is per-huddle, but memory is not.
    let memoryBlock = "";
    const ragCfg = agentBackend.rag;
    // Skip auto-retrieval on a ceremony kickoff. The trigger ("let's run the daily stand-up") embeds
    // to whatever the user was just chatting about, so retrieval pulled the prior casual discussion
    // into the FIRST agent's opening — "Iris repeats our old discussion before Terry begins", and
    // stale chunks (e.g. an "uploaded files" mention) surfaced too. A stand-up must open from its
    // task grounding, not from memory. This is the read-side complement to the write-side skip above
    // (isCeremonyTrigger): the ceremony neither writes the trigger to memory nor reads memory back in.
    if (!isCeremonyTrigger && ragCfg && ragCfg.store === "azure" && ragCfg.chunks && openaiKey) {
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
            .sort((a, b) => (b.score ?? 0) + laneBoost(b) - ((a.score ?? 0) + laneBoost(a)))
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

    // "researched" mode: auto-inject the LATEST canonical facts (non-superseded triples) so a value the
    // user changed (budget $8k→$10k, a dropped vendor, a moved date) is ALWAYS present and current — even
    // cross-huddle, where the short transcript window can't carry it and a stale chunk would otherwise win
    // retrieval. This is the piece that fixes the cross-huddle STALE result. Best-effort; never blocks.
    if (data.memoryMode === "researched" && ragCfg && ragCfg.store === "azure" && openaiKey) {
      try {
        const { azurePgStore } = await import("./rag/azure-pg.server");
        const facts = await azurePgStore.lookupTriples({
          query: data.text,
          mode: ragCfg.sharing ?? "shared",
          excludeSuperseded: true,
          k: 8,
        });
        if (facts.length) {
          memoryBlock +=
            "\n\nLatest known facts (these supersede anything older — treat as the current truth):\n" +
            facts.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`).join("\n");
        }
      } catch {
        /* best-effort — never block the reply */
      }
      // A2 ledger: inject the user's tracked facts & LISTS (authoritative current state) — user-scoped,
      // so a list edited in the group is current here in a 1:1. This is what fixes the cross-huddle
      // list-mutation case (vendors) that triple supersession alone can't. Best-effort.
      try {
        const email = await resolveCallerEmail();
        if (email) {
          const { getLedger, renderLedger } = await import("./rag/ledger-store.server");
          memoryBlock += renderLedger(await getLedger(email));
        }
      } catch {
        /* best-effort — never block the reply */
      }
    }

    const execBlock = await resolveExecContext();
    const appSystem =
      winner.systemPrompt +
      scene +
      roster +
      taskToolInstructions +
      capabilityBlock +
      memoryBlock +
      HOUSE_STYLE +
      OPERATING_CONTRACT +
      PROACTIVE_CAPTURE +
      DELEGATION_DIRECTIVE +
      execBlock;

    // Per-agent transcript: the current agent's own prior turns are role=assistant
    // (unprefixed); other agents' turns are surfaced as role=user context so the
    // model doesn't imitate a `[Name] ...` prefix pattern.
    // De-noise the window BEFORE the -14 cap: drop system lines AND reminder/alarm fire-echoes
    // (agent messages like "⏰ Alarm: …", id "rem-…") so those don't consume the limited context
    // slots and push the real dialogue out of view — the reminder-heavy-thread dilution that made
    // agents look like they'd forgotten. Non-destructive: only affects what the model reads per turn;
    // the full history stays intact in the store, the UI, and chat.pending_turns.
    // ACT-45: the CURRENT user message may carry attachments. Images are appended as Responses
    // `input_image` content parts (content becomes the parts-array form); text-file contents are inlined
    // into the message text. A barge (userTextOverride) never carries attachments. When there are none
    // the content stays a plain string, so the normal turn path is byte-for-byte unchanged.
    const { imageParts, inlineText } = userTextOverride
      ? { imageParts: [], inlineText: "" }
      : await resolveAttachmentContent();
    const currentUserText = userText + inlineText;
    type TranscriptContent =
      | string
      | Array<{ type: "input_text" | "input_image"; text?: string; image_url?: string }>;
    const currentUserContent: TranscriptContent =
      imageParts.length > 0
        ? [{ type: "input_text" as const, text: currentUserText }, ...imageParts]
        : currentUserText;

    const historyTranscript: Array<{ role: "user" | "assistant"; content: TranscriptContent }> = data.history
      .filter((m) => m.author.kind !== "system")
      .filter(
        (m) =>
          !(
            m.author.kind === "agent" &&
            (m.id.startsWith("rem-") || m.text.trimStart().startsWith("⏰"))
          ),
      )
      .slice(-14)
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
      });
    const transcript: Array<{ role: "user" | "assistant"; content: TranscriptContent }> = [
      ...historyTranscript,
      { role: "user" as const, content: currentUserContent },
    ];

    // DIAGNOSTIC (ceremony turns): does the reconstructed transcript actually feed this agent its own
    // prior line as role "assistant"? This is the ground-truth for the "agents don't recall what they
    // said" report — an own-line count of 0 here (while the agent DID speak) is the reconstruction bug.
    if (ceremonyDirective) {
      const ownAssistant = transcript.filter(
        (t) => t.role === "assistant" && !(typeof t.content === "string" && t.content.startsWith("(context —")),
      ).length;
      const roleShape = transcript.map((t) => t.role[0]).join("");
      console.log(
        `[huddle-memory] ceremony turn ${winner.id}: transcript ${transcript.length} msgs, own-assistant lines=${ownAssistant}, selfRecall=${selfRecallBlock ? "injected" : "empty"}, roles=${roleShape}`,
      );
    }

    const perAgentFallbacks: string[] = [];
    const timeSensitiveRe =
      /\b(today|tonight|tomorrow|yesterday|this week|this month|this year|latest|current|currently|right now|recent|recently|news|breaking|headline|score|price|stock|weather|forecast|202\d|updated|update)\b/i;
    const createTaskRe =
      /\b(add|create|make|log|track|put|place|capture|assign|todo|to-do|action item|follow[- ]?up)\b/i;
    // A reminder ("remind me in 30 min", "ping me at 3pm") is a timed nudge, NOT a backlog task —
    // route it to schedule_reminder and DON'T also force a task/web-search for the same message.
    const reminderRe =
      /\b(remind me|reminder|notify me|ping me|nudge me|alert me|wake me|set an alarm|alarm|message me (?:in|at|later|tonight|tomorrow)|text me (?:in|at))\b/i;
    // "remind me" is intent-ambiguous: "remind me to call mom at 5" is a schedule request, but "remind
    // me what we decided / who owns X / of the name" is a RECALL. Rather than special-case the reminder
    // regex, defer to the ONE semantic intent classifier (classifyTurnIntent): a recall classifies as
    // "query", so excluding query keeps recalls out of schedule_reminder and lets them flow to normal
    // answering + memory retrieval. Gate on !== "query" (not === "perform"): a genuine reminder is never
    // an interrogative recall, but CAN trip a non-perform class — e.g. "notify me when it's done" reads
    // as "status" via the embedded "it's done" — and must still force. Same principle as the
    // ACT-huddle-3 handoff gate: intent lives in the classifier, not in per-forcer regex.
    // All three gate on KEYWORD_TOOL_FORCING (off by design — semantic tool selection instead; see the
    // flag). The intra-flag structure is preserved for a clean rollback: the reminder→query exclusion,
    // the primary-only task force (interjectors surfaced duplicate cards), and web-search on webSearch
    // agents only. When the flag is false every one is false and tool_choice stays model-native.
    const forceReminder =
      KEYWORD_TOOL_FORCING && turnIntent !== "query" && reminderRe.test(userText);
    const forceTaskCreation =
      KEYWORD_TOOL_FORCING && !forceReminder && !isInterjector && createTaskRe.test(userText);
    const forceWebSearch =
      KEYWORD_TOOL_FORCING &&
      !forceReminder &&
      !!agentBackend.webSearch &&
      timeSensitiveRe.test(userText);

    // B2 assignee-scoped status guard (shared by the OpenAI + Lovable journey dispatch). Returns a
    // deferral RESULT object if `winner` may NOT change this task's status, or null to proceed.
    // Extends the meta-task-guard ownership model to STATUS CHANGES: only the task's assignee
    // (assigned_agent) or the board owner (special:"coordinator") may flip a status; anyone else
    // defers to the assignee. Fails OPEN — unassigned/unknown/not-yet-mirrored tasks and any DB error
    // proceed (no assignee to protect; a mirror lag must not block a legit update). Only blocks the
    // real B2 case: a non-assignee changing a task that belongs to a DIFFERENT agent.
    async function maybeDeferStatusChange(
      toolName: string,
      rawArgs: unknown,
    ): Promise<{ ok: true; deferred: true; assignedTo: string; note: string } | null> {
      if (!ASSIGNEE_SCOPED_STATUS || toolName !== "update_task") return null;
      const a = (rawArgs ?? {}) as Record<string, unknown>;
      // Cheap pre-checks first to avoid a DB hit when the guard can't apply.
      if (a.status == null || String(a.status).trim() === "") return null; // not a status change
      const isBoardOwner = winner.special === "coordinator";
      if (isBoardOwner) return null; // board owner may change any task
      const taskId = String(a.task_id ?? a.taskId ?? a.id ?? "").trim();
      if (!taskId) return null; // can't resolve which task — don't block
      const { getTaskAssignedAgent, shouldDeferStatusChange } =
        await import("./tasks/tasks.server");
      const assignee = await getTaskAssignedAgent(taskId);
      if (!assignee) return null; // unassigned/unknown/not-yet-mirrored → fail open
      if (
        !shouldDeferStatusChange({
          toolName,
          status: a.status,
          taskId,
          isBoardOwner,
          assignee,
          winnerId: winner.id,
        })
      ) {
        return null;
      }
      const owner = AGENT_BY_ID[assignee as AgentId];
      return {
        ok: true,
        deferred: true,
        assignedTo: assignee,
        note: `That task is assigned to ${owner?.name ?? assignee}. As ${winner.name} it isn't yours to re-status — defer to ${owner?.name ?? "its assignee"} (or the board owner) to make the change.`,
      };
    }

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
      // model, so enforce in code. Fires ONLY when the TITLE itself matches a capability trigger —
      // a genuine to-do ("renew passport") matches nothing and is untouched. Covers every
      // agent/capability, mirroring the groom_backlog exclusive-tool gate.
      //
      // Two shapes of the same failure, both blocked here: (1) cross-agent — a non-owner restates
      // another agent's exclusive job; (2) self — the OWNER restates its OWN job after performing it
      // (e.g. Terry filing "Groom backlog" right after grooming it, Cole filing "Assign tasks" right
      // after assigning). Case (2) slipped through the original owner-mismatch-only check and
      // polluted the live board (2026-07-31 incident) — the prose rule forbids restating a PERFORMED
      // action regardless of who performed it, so the code guard must too.
      const titleOwner = capabilityOwnerFor(title);
      if (titleOwner) {
        const isSelf = titleOwner.agent.id === winner.id;
        recordToolUse(
          winner.id,
          "create_huddle_task",
          isSelf
            ? `blocked self-restating meta-task “${title.slice(0, 60)}” — ${titleOwner.cap.label} is your own job, not a to-do`
            : `blocked meta-task “${title.slice(0, 60)}” — ${titleOwner.cap.label} belongs to ${titleOwner.agent.name}`,
          true,
        );
        return {
          ok: true,
          deferred: true,
          handedTo: isSelf ? undefined : titleOwner.agent.id,
          note: isSelf
            ? `That's your own job to perform, not a task to file — do it, don't card it.`
            : `That's ${titleOwner.agent.name}'s exclusive job — it's been handed to them; do not file a task about it.`,
        };
      }
      // Cross-agent / re-run dedup: if this exact title was already created earlier in this turn,
      // don't create a second card. The first caller claims the title here.
      const titleKey = title.trim().toLowerCase();
      if (createdTaskTitles.has(titleKey)) {
        recordToolUse(
          winner.id,
          "create_huddle_task",
          "already created this turn — skipped duplicate",
          true,
        );
        return { ok: true, deduped: true, task: { title: title.slice(0, 160) } };
      }
      // Cross-turn dedup: skip if an open task with this title already exists on the board.
      const existing = await loadExistingOpenTitles();
      if (existing.has(normTitle(title))) {
        createdTaskTitles.add(titleKey);
        recordToolUse(
          winner.id,
          "create_huddle_task",
          "an open task with this title already exists — skipped duplicate",
          true,
        );
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
      // Set ONLY when a journey write was attempted and failed. The Huddle-only path below is
      // shared by three cases (journey disabled, no caller, journey failed); a card is honest for
      // the first two but a GHOST for the third — journey is canonical, so no journey row means no
      // mirror row and nothing on the real board, however confident the reply sounds.
      let journeyFailed: string | null = null;
      if (agentBackend.journey?.enabled && data.caller?.entra_email) {
        try {
          const { invokeJourneyTool } = await import("./journey/proxy.functions");
          // Defense in depth: journey's `date` param only understands 'today'/'tomorrow'/YYYY-MM-DD.
          // Validate here (don't just trust the tool description) so a model slip — a weekday name,
          // "next Friday" — can't silently break the scheduling call; drop it and fall back to the
          // title-text NL parser, which handles those phrases correctly.
          const rawDate = typeof args.date === "string" ? args.date.trim().toLowerCase() : "";
          const dateArg =
            rawDate === "today" || rawDate === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
              ? rawDate
              : undefined;
          const r = await invokeJourneyTool({
            toolName: "quick_create_task",
            args: dateArg ? { title: task.title, date: dateArg } : { title: task.title },
            caller: data.caller ?? {},
            context: { source: "huddle", huddleId: data.huddleId, agentId: winner.id },
          });
          if (r.ok) {
            if (r.tasks && r.tasks.length > 0) journeyTaskUpdates.push(...r.tasks);
            else suggestedTasks.push(task); // journey didn't echo a row — keep a Huddle card
            // journey's `output` IS execute-tool's `result` object verbatim (huddle-proxy forwards
            // exec.result, not the sibling exec.message string) — parse it so the model can report
            // honestly instead of a flat "added it" that overclaims what actually happened (same-day
            // placement is provisional until tonight's planner runs; a future due date has no exact
            // time yet). Shape: {created, scheduled:[{title,time}], deferredToNightly:[{title,
            // due_date}], tasks:[{due_date,start_time,is_scheduled,...}]} — see parseAndCreateTasks.
            let outcomeNote: string | undefined;
            let outcome:
              | { due_date?: string | null; start_time?: string | null; is_scheduled?: boolean }
              | undefined;
            try {
              const parsed = JSON.parse(r.output) as {
                scheduled?: Array<{ title: string; time: string }>;
                deferredToNightly?: Array<{ title: string; due_date: string }>;
                tasks?: Array<{
                  due_date?: string | null;
                  start_time?: string | null;
                  is_scheduled?: boolean;
                }>;
              };
              outcome = parsed.tasks?.[0];
              if (parsed.scheduled && parsed.scheduled.length > 0) {
                outcomeNote = `scheduled at ${parsed.scheduled[0].time} today (provisional — the nightly planner may move it)`;
              } else if (parsed.deferredToNightly && parsed.deferredToNightly.length > 0) {
                outcomeNote = `due ${parsed.deferredToNightly[0].due_date} — no exact time yet, the nightly planner will place one`;
              } else if (outcome?.due_date && !outcome.start_time) {
                outcomeNote = `due ${outcome.due_date} — no exact time yet`;
              } else if (!outcome?.due_date && !outcome?.start_time) {
                outcomeNote = "added to the backlog, unscheduled";
              }
            } catch {
              /* r.output wasn't the expected JSON shape — outcome stays undefined, note omitted */
            }
            recordToolUse(
              winner.id,
              "create_huddle_task",
              `“${task.title}” → Huddle board + journey${outcomeNote ? ` — ${outcomeNote}` : ""}`,
              true,
            );
            return { ok: true, task, boards: ["huddle", "journey"], outcome, note: outcomeNote };
          }
          const ev = recordFallback(
            "tool",
            `${winner.name}: could NOT save “${task.title}” to your board — journey create failed — ${r.error ?? "unknown"}`,
            "journey task create failed",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
          journeyFailed = r.error ?? "unknown error";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const ev = recordFallback(
            "tool",
            `${winner.name}: could NOT save “${task.title}” to your board — journey create crashed — ${msg}`,
            "journey task create crashed",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
          journeyFailed = msg;
        }
      }

      // Journey was attempted and FAILED: report it honestly. Do NOT render a board card — journey
      // is the canonical store, so a card here would show a task that exists nowhere but the screen
      // (no journey row -> no mirror row). ok:false so the model reports the failure instead of the
      // flat "added it" the user saw, and the breadcrumb shows a cross rather than a tick.
      if (journeyFailed) {
        recordToolUse(
          winner.id,
          "create_huddle_task",
          `FAILED to save “${task.title}” to the board — ${journeyFailed}`,
          false,
        );
        return {
          ok: false,
          error: `Could not save “${task.title}” to the board: ${journeyFailed}`,
          note: "Tell the user plainly that it was NOT saved and offer to retry — do not claim it was added.",
          task,
          boards: [],
        };
      }

      // Huddle-only path (journey deliberately disabled, or no caller identity). A card is correct
      // here: no journey write was attempted, so nothing is being misrepresented.
      suggestedTasks.push(task);
      recordToolUse(
        winner.id,
        "create_huddle_task",
        `suggested “${task.title}” · owner ${AGENT_BY_ID[task.ownerId].name}`,
        true,
      );
      return { ok: true, task, boards: ["huddle"] };
    }

    // Batch create — the honest multi-task path. When the user asks for SEVERAL tasks in one message
    // ("add these three…", "gym at 9, lunch at 12, call mom at 5") a model would otherwise emit a
    // single create_huddle_task and then narrate "created all of them" — the exact over-claim the user
    // hit (asked for 2, one created, told "both done"). This routes the whole set through journey's
    // purpose-built `parse_and_create_tasks` (NL multi-task parser + conflict-aware co-scheduler),
    // creating ALL of them in one call, and returns the EXACT created count so the reply can be
    // truthful. Per-entry it runs the same guards as the single path (exclusive-capability meta-task
    // guard + within-turn/cross-turn dedup); anything skipped is reported, never silently dropped.
    async function createBatchTasksFromTool(args: Record<string, unknown>) {
      // Accept an explicit list (preferred — the model enumerates each task) or a single multi-task
      // text blob. A blob is kept intact for journey's NL parser (it extracts times/dates); only split
      // on hard separators so a compound single task isn't torn apart.
      const rawList = Array.isArray(args.tasks)
        ? (args.tasks as unknown[]).map((t) => String(t ?? "").trim()).filter(Boolean)
        : [];
      const blob = typeof args.text === "string" ? args.text.trim() : "";
      let entries = rawList;
      if (!entries.length && blob) {
        entries = blob
          .split(/\n|;/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!entries.length) entries = [blob];
      }
      if (!entries.length) {
        const error = "create_huddle_tasks requires a non-empty `tasks` array (or `text`)";
        recordToolUse(winner.id, "create_huddle_tasks", "batch task creation failed", false, error);
        return { ok: false, error };
      }

      // Per-entry guards (mirror the single path): exclusive-capability meta-task guard + dedup.
      const existing = await loadExistingOpenTitles();
      const survivors: string[] = [];
      const skipped: Array<{ title: string; reason: string }> = [];
      const deferred: Array<{ title: string; handedTo?: string; reason: string }> = [];
      for (const entry of entries) {
        const titleOwner = capabilityOwnerFor(entry);
        if (titleOwner) {
          const isSelf = titleOwner.agent.id === winner.id;
          deferred.push({
            title: entry,
            handedTo: isSelf ? undefined : titleOwner.agent.id,
            reason: isSelf
              ? `${titleOwner.cap.label} is your own job to perform, not a card`
              : `${titleOwner.cap.label} belongs to ${titleOwner.agent.name}`,
          });
          continue;
        }
        const key = entry.trim().toLowerCase();
        if (createdTaskTitles.has(key) || existing.has(normTitle(entry))) {
          createdTaskTitles.add(key);
          skipped.push({ title: entry, reason: "an open task with this title already exists" });
          continue;
        }
        createdTaskTitles.add(key);
        survivors.push(entry);
      }

      if (!survivors.length) {
        recordToolUse(
          winner.id,
          "create_huddle_tasks",
          `no new tasks created — ${deferred.length} deferred, ${skipped.length} duplicate`,
          true,
        );
        return { ok: true, requested: entries.length, created: 0, deferred, skipped, tasks: [] };
      }

      // Journey batch path: ONE parse_and_create_tasks call creates every survivor, co-scheduled.
      if (agentBackend.journey?.enabled && data.caller?.entra_email) {
        try {
          const { invokeJourneyTool } = await import("./journey/proxy.functions");
          const rawDate = typeof args.date === "string" ? args.date.trim().toLowerCase() : "";
          const target_date =
            rawDate === "today" || rawDate === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
              ? rawDate
              : undefined;
          const r = await invokeJourneyTool({
            toolName: "parse_and_create_tasks",
            args: {
              text: survivors.join("\n"),
              auto_schedule: true,
              ...(target_date ? { target_date } : {}),
            },
            caller: data.caller ?? {},
            context: { source: "huddle", huddleId: data.huddleId, agentId: winner.id },
          });
          if (r.ok) {
            let created = 0;
            let createdTasks: unknown[] = [];
            if (r.tasks && r.tasks.length > 0) {
              journeyTaskUpdates.push(...r.tasks);
              created = r.tasks.length;
              createdTasks = r.tasks;
            } else {
              // journey didn't echo rows — recover the count from the result payload.
              try {
                const parsed = JSON.parse(r.output) as { tasks?: unknown[]; created?: number };
                created =
                  typeof parsed.created === "number"
                    ? parsed.created
                    : (parsed.tasks?.length ?? survivors.length);
                createdTasks = parsed.tasks ?? [];
              } catch {
                created = survivors.length;
              }
            }
            recordToolUse(
              winner.id,
              "create_huddle_tasks",
              `created ${created}/${survivors.length} → Huddle board + journey` +
                `${deferred.length ? ` · ${deferred.length} deferred` : ""}${skipped.length ? ` · ${skipped.length} duplicate` : ""}`,
              true,
            );
            return {
              ok: true,
              requested: entries.length,
              created,
              tasks: createdTasks,
              deferred,
              skipped,
              boards: ["huddle", "journey"],
            };
          }
          const ev = recordFallback(
            "tool",
            `${winner.name}: batch task create failed on journey — ${r.error ?? "unknown"}`,
            "journey batch task create failed",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const ev = recordFallback(
            "tool",
            `${winner.name}: batch task create crashed — ${msg}`,
            "journey batch task create crashed",
            winner.id,
          );
          perAgentFallbacks.push(ev.inline);
        }
      }

      // Huddle-only fallback (journey off, no caller, or journey failed): one card per survivor.
      const cards: SuggestedTaskDraft[] = survivors.map((title) => ({
        id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.slice(0, 160),
        ownerId: resolveTaskOwner(args.ownerId ?? args.owner ?? args.assignee),
        lane: resolveTaskLane(args.lane ?? args.status),
      }));
      suggestedTasks.push(...cards);
      recordToolUse(
        winner.id,
        "create_huddle_tasks",
        `created ${cards.length}/${survivors.length} Huddle-only${deferred.length ? ` · ${deferred.length} deferred` : ""}`,
        true,
      );
      return {
        ok: true,
        requested: entries.length,
        created: cards.length,
        tasks: cards,
        deferred,
        skipped,
        boards: ["huddle"],
      };
    }

    try {
      let clean = "";
      let usedBackend: "openai" | "lovable" = agentBackend.backend;
      let usedModel = "";
      let usedInstructions = "";
      let fromSnapshot = false;
      let toolTypes: string[] = [];
      // Central model-usage tracking: the difficulty the router scored this turn and the reasoning
      // effort the resolver picked, persisted per prompt so `chat.model_usage` can attribute every
      // model spend to its difficulty/effort (see the view DDL + the tracking notes in memory.md).
      let usedDifficulty: number | null = null;
      let usedEffort: string | null = null;

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
          // Hand-off hint keys on the REAL "a teammate passed this" signal (`data.internal`, set only by
          // deliverOwnerFollowup), NOT on scope. group → do-and-report; 1:1 follow-up → defer+confirm;
          // 1:1 DIRECT ask (the common case) → just groom. Gating on scope alone made every direct 1:1
          // ask defer and parrot "a teammate flagged it" — the reported Terry bug.
          const groomHandoffHint =
            data.scope === "group"
              ? groom.GROOM_HANDOFF_DO_HINT
              : data.internal
                ? groom.GROOM_HANDOFF_CONFIRM_HINT
                : groom.GROOM_HANDOFF_DIRECT_HINT;
          groomHint = "\n\n" + groom.GROOM_SYSTEM_HINT + groomHandoffHint;
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
        // execContextBlock is resolved once per turn (appSystem, which runs before this OpenAI branch,
        // already awaited resolveExecContext). OPERATING_CONTRACT + the profile are both stable
        // (static / stable-per-user), so they belong in the cache-stable prefix.
        const stableInstructions =
          (effectiveInstructions || winner.systemPrompt) +
          roster +
          taskToolInstructions +
          capabilityBlock +
          HOUSE_STYLE +
          OPERATING_CONTRACT +
          PROACTIVE_CAPTURE +
          DELEGATION_DIRECTIVE +
          (execContextBlock ?? "") +
          ragInstructions +
          webInstructions +
          "\n\n" +
          PRIORITIZE_SYSTEM_HINT +
          groomHint +
          "\n\n" +
          REMINDER_SYSTEM_HINT;
        const volatileInstructions = scene + memoryBlock + groundingBlock(!!agentBackend.webSearch);
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
              date: {
                type: "string",
                description:
                  "Optional, ONLY for exactly 'today', 'tomorrow', or an explicit YYYY-MM-DD you are certain of. For any other date the user stated (a weekday name, 'next Tuesday', 'by Friday'), do NOT put it here — leave this unset and instead keep that exact date phrase in the title text (e.g. \"Renew passport by Friday\"), which is parsed correctly server-side. Putting an unsupported value here silently breaks scheduling.",
              },
            },
            required: ["title"],
          },
          strict: false,
        };

        const createHuddleTasksTool = {
          type: "function" as const,
          name: "create_huddle_tasks",
          description:
            'Create MULTIPLE tasks at once. Use this — NOT repeated create_huddle_task calls — whenever the user asks for more than one task in a single message (e.g. "add these three…", "gym at 9, lunch at 12, call mom at 5"). Each task is added to the Huddle board and, when journey is connected, created + co-scheduled on their journey board in one pass. The result tells you EXACTLY how many were created — report that number, never assume all of them landed.',
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              tasks: {
                type: "array",
                items: { type: "string" },
                description:
                  'The tasks to create, one string each. Keep any time/date phrase inline in the string (e.g. "Gym at 9am", "Call mom tomorrow") — it is parsed and scheduled server-side.',
              },
              date: {
                type: "string",
                description:
                  "Optional shared date for the whole batch, ONLY 'today', 'tomorrow', or an explicit YYYY-MM-DD. For any other phrasing keep it inline in each task string instead.",
              },
            },
            required: ["tasks"],
          },
          strict: false,
        };

        // Native Huddle email (Microsoft Graph). Offered when the Graph app
        // creds are configured; sends as an allow-listed tenant mailbox.
        const { emailFromOptions, graphEmailConfigured } =
          await import("./email/graph-email.server");
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
          // Raw external Outlook/Microsoft calendar (Graph) — explicit-only, gated on Graph config.
          emailTools.push(GET_EXTERNAL_CALENDAR_EVENTS_TOOL);
        }

        const { PRIORITIZE_TOOL } = await import("./tasks/tools");
        // The scrum master alone gets the backlog-grooming tool (Jira-style triage/assign).
        const groomTools = ownsGrooming ? [(await import("./tasks/groom")).GROOM_BACKLOG_TOOL] : [];
        const { SCHEDULE_REMINDER_TOOL } = await import("./tasks/reminders");
        const mergedTools = [
          createHuddleTaskTool,
          createHuddleTasksTool,
          CREATE_ARTIFACT_TOOL,
          DELEGATE_TO_SPECIALIST_TOOL,
          FLAG_BLOCKER_TOOL,
          CONFIRM_TASK_INTENT_TOOL,
          PROPOSE_TASK_INTENT_TOOL,
          PROPOSE_APPROACH_TOOL,
          ASK_CLARIFYING_QUESTION_TOOL,
          RESOLVE_CLARIFYING_QUESTION_TOOL,
          SCHEDULE_REMINDER_TOOL,
          PRIORITIZE_TOOL,
          GET_CALENDAR_EVENTS_TOOL, // calendar-framed alias → combined schedule (always available)
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
          // E (F13): a REAL tool is about to run — mark its START so the client can voice an honest,
          // event-driven progress cue for it (no-op outside a ceremony/barge run).
          trackCeremonyToolStart(winner.id, c.name);
          if (c.name === "create_huddle_task") {
            return JSON.stringify(await createSuggestedTaskFromTool(c.arguments));
          }
          if (c.name === "create_huddle_tasks") {
            return JSON.stringify(await createBatchTasksFromTool(c.arguments));
          }
          if (c.name === "delegate_to_specialist") {
            return await dispatchDelegate(c.arguments);
          }
          if (c.name === "create_artifact") {
            const a = c.arguments as Record<string, unknown>;
            const name = String(a.name ?? "").trim();
            const content = String(a.content ?? "");
            const taskIdRaw = a.task_id ? String(a.task_id) : "";
            if (!name || !content)
              return JSON.stringify({ ok: false, error: "name and content are required" });
            // Include the task's current revision_count in the dedup key so a revise-and-resave
            // (same task+name, after the review gate below sends it back) isn't blocked as "already
            // saved this turn" — only a TRUE repeat at the same revision is deduped.
            let revisionCountForClaim = 0;
            if (taskIdRaw) {
              try {
                const { getTaskEngagementState } = await import("./tasks/tasks.server");
                revisionCountForClaim =
                  (await getTaskEngagementState(taskIdRaw))?.revision_count ?? 0;
              } catch {
                /* default 0 */
              }
            }
            if (!claimAction(`create_artifact:${taskIdRaw}:${name}:${revisionCountForClaim}`)) {
              recordToolUse(
                winner.id,
                "create_artifact",
                "already saved this turn — skipped duplicate",
                true,
              );
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
                taskId: taskIdRaw || null,
                folder: String(a.folder ?? "Research"),
                name,
                mime: String(a.mime ?? "text/markdown"),
                bytes: Buffer.from(content, "utf8"),
              });
              let reviewSuffix = "";
              let review:
                { proceed: boolean; message: string; deficiencies?: string[] } | undefined;
              if (taskIdRaw) {
                // Hardened review gate (docs/plan-wip-confirm-review-gate.md, Part 2) — a code MUST
                // when requireStructuredWorkflow is ON, not a prompt "should". A no-op when it's OFF.
                const { runReviewGate } = await import("./tasks/review-gate.server");
                const gate = await runReviewGate({
                  taskId: taskIdRaw,
                  agentId: winner.id,
                  email,
                  content,
                  claim: claimAction,
                });
                if (gate.proceed) {
                  const { ensureReviewFlip } = await import("./tasks/tasks.server");
                  const flip = await ensureReviewFlip(taskIdRaw, email, data.caller, winner.id);
                  if (flip.pendingConfirm) {
                    reviewSuffix =
                      " · saved, but held out of review — confirm intent with the user first";
                    review = {
                      proceed: false,
                      message:
                        "Your work is saved, but this task can't move to the user's review queue yet: you never confirmed the Definition of Done with them. Send them the confirm-intent ask now (what you believe they wanted + the DoD, and ask them to confirm/correct it), then call confirm_task_intent once they reply.",
                    };
                  }
                }
                if (gate.gated) {
                  reviewSuffix = ` · ${gate.note}`;
                  review = {
                    proceed: gate.proceed,
                    message: gate.proceed
                      ? "Review passed — this is now in the user's review queue."
                      : `Sent back for one revision before it can move to review: ${(gate.deficiencies ?? []).join("; ")}. Address these and call create_artifact again with the same task_id and name to resave.`,
                    deficiencies: gate.deficiencies,
                  };
                }
              }
              recordToolUse(
                winner.id,
                "create_artifact",
                `saved "${name}"${reviewSuffix}`,
                true,
                deepLink,
              );
              return JSON.stringify({ ok: true, id, deepLink, ...(review ? { review } : {}) });
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
            if (!taskId || !reason)
              return JSON.stringify({ ok: false, error: "task_id and reason are required" });
            if (!claimAction(`flag_blocker:${taskId}`)) {
              recordToolUse(
                winner.id,
                "flag_blocker",
                "already flagged this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({ ok: true, deduped: true });
            }
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              // Set the journey task status=BLOCKED FIRST — it validates the task_id against the canonical
              // board (service-role update) and syncs back to the mirror. ONLY if the board actually
              // changed do we record the reason Huddle-native. Ordering matters: agents sometimes pass a
              // non-uuid task_id (a title or a slug) that matches no journey row; recording the reason
              // first left an ORPHAN blocker row AND let the agent report "blocked" while journey/mirror
              // stayed unchanged — a false positive the user sees as blocked-but-not-blocked. Gate both
              // writes on the board write so they can't disagree. (Unblock: a non-BLOCKED status syncing
              // back in clears the reason row.)
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
                if (!r.ok)
                  boardError = String(r.error ?? r.output ?? "update_task_failed").slice(0, 160);
              } catch (e) {
                boardError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
              }
              if (!boardStatusSet) {
                // Board write failed (usually a stale/incorrect task_id). Do NOT record a reason row and
                // do NOT let the agent claim it's blocked — surface the failure so it reports honestly.
                recordToolUse(
                  winner.id,
                  "flag_blocker",
                  `could not block — board not updated: ${boardError}`,
                  false,
                  boardError || undefined,
                );
                return JSON.stringify({
                  ok: false,
                  task_id: taskId,
                  board_status_set: false,
                  error: `Could not mark the task blocked (${boardError}). Do NOT tell the user it is blocked — say you could not flag it and confirm the exact task with them.`,
                });
              }
              // Board is BLOCKED — record the specific reason Huddle-native (journey has no reason field).
              const { setTaskBlocker } = await import("./tasks/tasks.server");
              await setTaskBlocker(email, taskId, reason, winner.id);
              recordToolUse(winner.id, "flag_blocker", `blocked: ${reason.slice(0, 50)}`, true);
              return JSON.stringify({
                ok: true,
                task_id: taskId,
                board_status_set: true,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "flag_blocker", "flag failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "propose_task_intent") {
            const a = c.arguments as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const taskTitle = String(a.task_title ?? "").trim();
            const dod = String(a.definition_of_done ?? "").trim();
            if (!taskId || !dod)
              return JSON.stringify({
                ok: false,
                error: "task_id and definition_of_done are required",
              });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { proposeTaskDod } = await import("./tasks/tasks.server");
              await proposeTaskDod(taskId, email, dod);
              // Encoded as JSON in `detail` (a plain string field) so the reply-assembly step below can
              // recover structured {taskId, taskTitle, proposedDod} the same way replyArtifacts recovers
              // an artifact id from create_artifact's detail — this is what drives the confirm-ask
              // button row on THIS specific message.
              recordToolUse(
                winner.id,
                "propose_task_intent",
                `Proposed DoD for "${taskTitle || taskId}"`,
                true,
                JSON.stringify({ taskId, taskTitle, proposedDod: dod }),
              );
              return JSON.stringify({ ok: true, task_id: taskId });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "propose_task_intent", "propose failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "confirm_task_intent") {
            const a = c.arguments as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const dod = String(a.definition_of_done ?? "").trim();
            if (!taskId || !dod)
              return JSON.stringify({
                ok: false,
                error: "task_id and definition_of_done are required",
              });
            if (!claimAction(`confirm_task_intent:${taskId}`)) {
              recordToolUse(
                winner.id,
                "confirm_task_intent",
                "already confirmed this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({ ok: true, deduped: true });
            }
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { confirmTaskIntent } = await import("./tasks/tasks.server");
              await confirmTaskIntent(taskId, email, dod);
              // Durably on journey's canonical task too (flows to the mirror + board tooltip).
              let journeySet = false;
              let journeyError = "";
              try {
                const { invokeJourneyTool } = await import("./journey/proxy.functions");
                const r = await invokeJourneyTool({
                  toolName: "update_task",
                  args: { task_id: taskId, definition_of_done: dod },
                  caller: data.caller ?? {},
                  context: { source: "huddle" },
                });
                journeySet = !!r.ok;
                if (!r.ok)
                  journeyError = String(r.error ?? r.output ?? "update_task_failed").slice(0, 160);
              } catch (e) {
                journeyError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
              }
              recordToolUse(
                winner.id,
                "confirm_task_intent",
                journeySet
                  ? "DoD confirmed"
                  : `DoD confirmed, journey write failed: ${journeyError}`,
                true,
                journeyError || undefined,
              );
              return JSON.stringify({ ok: true, task_id: taskId, journey_set: journeySet });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "confirm_task_intent", "confirm failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "propose_approach") {
            const a = c.arguments as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const approach = String(a.approach ?? "").trim();
            if (!taskId || !approach)
              return JSON.stringify({ ok: false, error: "task_id and approach are required" });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { getTaskTitle } = await import("./tasks/tasks.server");
              const title = await getTaskTitle(taskId);
              const { runApproachGate } = await import("./tasks/approach-gate.server");
              const gate = await runApproachGate({
                taskId,
                agentId: winner.id,
                email,
                taskTitle: title,
                approach,
                claim: claimAction,
              });
              recordToolUse(
                winner.id,
                "propose_approach",
                gate.approved
                  ? "approach approved"
                  : gate.escalated
                    ? "approach escalated to user"
                    : `sent back — ${gate.note}`,
                true,
              );
              return JSON.stringify({
                ok: true,
                approved: gate.approved,
                escalated: gate.escalated,
                note: gate.note,
                ...(gate.deficiencies ? { deficiencies: gate.deficiencies } : {}),
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "propose_approach", "approach gate failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "ask_clarifying_question") {
            const a = c.arguments as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const question = String(a.question ?? "").trim();
            if (!taskId || !question)
              return JSON.stringify({ ok: false, error: "task_id and question are required" });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { getTaskEngagementState, openClarifyingQuestion } =
                await import("./tasks/tasks.server");
              const { getWorkflowCaps } = await import("./identity/agent-workflow-config.server");
              const state = await getTaskEngagementState(taskId);
              if (state?.clarify_status === "open") {
                recordToolUse(
                  winner.id,
                  "ask_clarifying_question",
                  "already has an open question — wait for the reply",
                  false,
                );
                return JSON.stringify({
                  ok: false,
                  error:
                    "This task already has an open question awaiting the user's reply — wait for their answer before asking another.",
                });
              }
              const caps = await getWorkflowCaps(email, winner.id).catch(() => ({
                approach: 3,
                review: 3,
                question: 2,
              }));
              const currentCount = state?.clarify_count ?? 0;
              if (currentCount >= caps.question) {
                recordToolUse(
                  winner.id,
                  "ask_clarifying_question",
                  `cap reached (${caps.question})`,
                  false,
                );
                return JSON.stringify({
                  ok: false,
                  error: `You've already asked the max (${caps.question}) clarifying questions on this task. Proceed on your best judgment, or call flag_blocker if you genuinely cannot continue.`,
                });
              }
              const count = await openClarifyingQuestion(taskId, email, question);
              recordToolUse(
                winner.id,
                "ask_clarifying_question",
                `asked (${count}/${caps.question}): ${question.slice(0, 80)}`,
                true,
              );
              return JSON.stringify({ ok: true, task_id: taskId, count, cap: caps.question });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "ask_clarifying_question", "ask failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "resolve_clarifying_question") {
            const a = c.arguments as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            if (!taskId) return JSON.stringify({ ok: false, error: "task_id is required" });
            try {
              const { closeClarifyingQuestion } = await import("./tasks/tasks.server");
              await closeClarifyingQuestion(taskId);
              recordToolUse(winner.id, "resolve_clarifying_question", "resumed", true);
              return JSON.stringify({ ok: true });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "resolve_clarifying_question", "resolve failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          }
          if (c.name === "schedule_reminder") {
            const a = c.arguments as Record<string, unknown>;
            if (
              !claimAction(`reminder:${a.text ?? ""}:${a.delay_minutes ?? ""}:${a.at_time ?? ""}`)
            ) {
              recordToolUse(
                winner.id,
                "schedule_reminder",
                "already scheduled this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({
                ok: true,
                deduped: true,
                message: "That reminder was already scheduled this turn.",
              });
            }
            const { dispatchScheduleReminder } = await import("./tasks/reminders");
            const out = await dispatchScheduleReminder(
              data.caller,
              c.arguments,
              data.huddleId,
              winner.id,
              data.timeZone,
            );
            const ok = !JSON.parse(out).error;
            recordToolUse(
              winner.id,
              "schedule_reminder",
              ok ? "reminder scheduled" : "reminder · failed",
              ok,
            );
            return out;
          }
          if (c.name === "schedule_and_priorities" || c.name === "get_calendar_events") {
            const { dispatchPrioritize } = await import("./tasks/tools");
            // One resolution gives BOTH the canonical email (to scope the read) and the canonical
            // timezone (to localize the returned times). data.timeZone is the browser zone this turn.
            const ident = await (
              await import("./journey/identity")
            ).resolveJourneyIdentity(data.caller, data.timeZone);
            const email = ident.email ?? data.caller?.entra_email;
            const tz = ident.timeZone || data.timeZone || "UTC";
            // get_calendar_events is a calendar-framed ALIAS → the SAME combined-schedule executor,
            // defaulting to the day's scheduled view (a model-supplied view still wins). One executor.
            const pArgs =
              c.name === "get_calendar_events"
                ? { view: "scheduled", ...c.arguments }
                : c.arguments;
            const out = await dispatchPrioritize(email, pArgs, tz);
            // Record it like every other tool (this was the ONE tool missing recordToolUse, which is
            // why it never showed in the tool trace / UAT even though it ran).
            let ok = true,
              detail = "";
            try {
              const p = JSON.parse(out) as { error?: string; view?: string; count?: number };
              ok = !p.error;
              detail = p.error ? String(p.error) : `view=${p.view ?? "?"} count=${p.count ?? "?"}`;
            } catch {
              /* keep defaults */
            }
            recordToolUse(
              winner.id,
              c.name,
              ok ? "read schedule/priorities" : "schedule read failed",
              ok,
              detail,
            );
            return out;
          }
          if (c.name === "groom_backlog") {
            const { dispatchGroomBacklog } = await import("./tasks/groom");
            const out = await dispatchGroomBacklog(data.caller, c.arguments);
            let groomDetail = "";
            try {
              const p = JSON.parse(out) as {
                _timings?: { readMs: number; classifyMs: number; writeMs: number; tasks: number };
              };
              if (p._timings)
                groomDetail = `read=${p._timings.readMs}ms classify=${p._timings.classifyMs}ms write=${p._timings.writeMs}ms tasks=${p._timings.tasks}`;
            } catch {
              /* ignore */
            }
            recordToolUse(winner.id, "groom_backlog", "groomed the backlog", true, groomDetail);
            return out;
          }
          if (c.name === "send_email") {
            const a = c.arguments as Record<string, unknown>;
            if (!claimAction(`send_email:${a.to ?? ""}:${a.subject ?? ""}`)) {
              recordToolUse(
                winner.id,
                "send_email",
                "already sent this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({
                ok: true,
                deduped: true,
                message: "That email was already sent this turn.",
              });
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
              recordToolUse(
                winner.id,
                "create_email_draft",
                "already drafted this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({
                ok: true,
                deduped: true,
                message: "That draft was already created this turn.",
              });
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
                r.ok
                  ? `draft saved in ${r.from} (id ${String(r.id ?? "").slice(0, 12)}…)`
                  : "draft failed",
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
          if (c.name === "get_external_calendar_events") {
            const a = c.arguments as Record<string, unknown>;
            try {
              const tz = data.timeZone || "UTC";
              const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
              const startRaw =
                typeof a.start === "string" && a.start.trim() ? a.start.trim() : todayStr;
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
                "get_external_calendar_events",
                r.ok
                  ? `${r.events?.length ?? 0} event(s) ${startDay}${endDay !== startDay ? `..${endDay}` : ""}`
                  : "calendar read failed",
                r.ok,
                r.ok ? undefined : r.error,
              );
              if (!r.ok) {
                const ev = recordFallback(
                  "tool",
                  `${winner.name}: get_external_calendar_events failed — ${r.error ?? "unknown"}`,
                  "get_external_calendar_events failed",
                  winner.id,
                );
                perAgentFallbacks.push(ev.inline);
              }
              return JSON.stringify(r);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(
                winner.id,
                "get_external_calendar_events",
                "calendar read crashed",
                false,
                msg,
              );
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
              const defer = await maybeDeferStatusChange(c.name, c.arguments);
              if (defer) {
                recordToolUse(
                  winner.id,
                  c.name,
                  `deferred — task assigned to ${defer.assignedTo}, not ${winner.id}`,
                  true,
                );
                return JSON.stringify(defer);
              }
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
                r.ok ? undefined : String(r.error ?? r.output ?? "unknown"),
                c.arguments,
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

        // Base model before the difficulty resolver overrides it below. config.model (per-agent 5.6
        // default) wins; the snapshot's model is an informational fallback; the final literal is a 5.6
        // floor, never the legacy gpt-4o.
        usedModel = agentBackend.model?.trim() || snapshot?.model || "gpt-5.6-luna";

        // Difficulty-driven model/effort (the validated cost lever). The LLM router scores each turn 1-4;
        // routine→Luna-low, standard→Luna-high, deep→Sol-high. Escalating THINKING on the cheap model
        // (luna-high ≈ terra-med at ~1/9 cost, measured) beats jumping the model, so most turns run Luna
        // with more effort and only genuinely deep asks reach Sol. Sol auto-spend is gated upstream (a
        // fresh 1:1 deep ask is confirm-gated), so if we still see needsConfirm here (a group deep ask,
        // or an un-gated path) we do NOT silently spend Sol — we drop to the Terra-high budget. A manual
        // override (deepManual) always wins and clears the gate. Guarded: any failure keeps the static
        // agent-backend model so a bad resolve never breaks the turn.
        let personaReasoningEffort: Effort | undefined;
        try {
          const resolved = resolveByDifficulty(
            routed.difficulty ?? 2,
            winner.id,
            effectiveModelPolicy(data.agents, data.modelPolicy),
            { manual: deepManual },
          );
          let chosenModel = resolved.model;
          let chosenEffort = resolved.effort;
          if (resolved.needsConfirm && !deepManual) {
            chosenModel = resolved.budgetModel; // never auto-spend Sol without confirm/override
            chosenEffort = "high";
          }
          usedDifficulty = routed.difficulty ?? 2;
          if (chosenModel) {
            usedModel = chosenModel;
            personaReasoningEffort = chosenEffort;
            usedEffort = chosenEffort ?? null;
            // Minimal tier surfacing (first cut of the "thinking dots"): only note ESCALATED tiers (o3 =
            // the deep rung, or Sol via manual) so routine Luna turns stay silent. Rides the existing
            // reasoning-summary channel to the UI.
            if (chosenModel === "o3" || chosenModel.includes("sol") || deepManual) {
              reasoningSummaries.push(
                `${winner.name}: reasoning tier ${chosenModel.replace("gpt-5.6-", "")}/${chosenEffort}${deepManual ? " (you chose this)" : ""}`,
              );
            }
          }
        } catch (err) {
          console.warn(
            `[huddle-model] difficulty resolve failed for ${winner.id}: ${err instanceof Error ? err.message : String(err)}; keeping ${usedModel}.`,
          );
        }

        const toolChoice = forceReminder
          ? { type: "function", name: "schedule_reminder" }
          : forceTaskCreation
            ? { type: "function", name: "create_huddle_task" }
            : forceWebSearch
              ? { type: "function", name: "tavily_web_search" }
              : undefined;

        if (forceReminder) {
          recordToolUse(
            winner.id,
            "schedule_reminder",
            "offered (forced — reminder request)",
            true,
          );
        } else if (forceTaskCreation) {
          recordToolUse(winner.id, "create_huddle_task", "offered (forced — task request)", true);
        } else if (forceWebSearch) {
          recordToolUse(winner.id, "tavily_web_search", "offered (forced — time-sensitive)", true);
        }

        // memoryMode "conversation" (1:1 DMs only): carry short-term continuity via an OpenAI
        // Conversations object instead of resending the reconstructed 14-message window — so
        // "what did we say one turn ago" is native server-side state, not a noise-diluted slice.
        // Group huddles KEEP reconstruction (a shared object would blur the multiple agents'
        // identities). RAG (auto-retrieval + search_memory) still layers on top either way. Fails
        // safe: any miss (no email, DB/OpenAI error) falls back to the full transcript this turn.
        let conversationId: string | undefined;
        let conversationEmail: string | null = null;
        let personaTranscript = transcript;
        // "researched" is a SUPERSET of "conversation": 1:1 DMs behave identically (native thread),
        // while group/ceremony turns additionally persist agent replies + tool-confirmed triples and
        // rank retrieval by recency/supersession (see the post-turn memory write below).
        if (
          (memoryMode === "conversation" || memoryMode === "researched") &&
          data.scope === "one-to-one"
        ) {
          try {
            const email = await resolveCallerEmail();
            const { getOrCreateConversationId } = await import("./rag/conversation-store.server");
            const convId = await getOrCreateConversationId({
              userEmail: email,
              huddleId: data.huddleId,
              agentId: winner.id,
              // Prior turns only (the new user msg is sent as input below). Prior items always have
              // string content — attachments only ever ride on the current/last message — so this map
              // just satisfies the string-content seed type (ACT-45).
              seed: transcript.slice(0, -1).map((t) => ({
                role: t.role,
                content: typeof t.content === "string" ? t.content : "",
              })),
            });
            if (convId) {
              conversationId = convId;
              conversationEmail = email;
              // Send only the new user message (the conversation object owns prior state) — but keep any
              // image/inline-file content so an attachment reaches the agent in conversation mode too. ACT-45.
              personaTranscript = [{ role: "user" as const, content: currentUserContent }];
              console.log(
                `[huddle-memory] memoryMode="conversation" active for ${winner.id} in ${data.huddleId}`,
              );
            } else {
              console.warn(
                `[huddle-memory] memoryMode="conversation": no conversation for ${winner.id}; reconstruction this turn.`,
              );
            }
          } catch (err) {
            console.warn(
              `[huddle-memory] conversation-mode error for ${winner.id}: ${err instanceof Error ? err.message : String(err)}; using reconstruction.`,
            );
          }
        }

        // 1:1 reply streaming (Settings-gated): persist the growing answer to the durable row as it
        // streams so the client poll renders it forming, instead of waiting for the whole reply (and a
        // slow high-effort reply isn't cut at the deadline). Only the lone 1:1 agent, only in
        // chunked/durable mode, only when the toggle is on (default on). Throttled ~1s. Guarded — a
        // stream error inside callOpenAIResponses falls back to a normal call. Groups/ceremonies never
        // stream here (gate requires scope one-to-one).
        const streamOneOnOne =
          chunked &&
          !!turnId &&
          !!turnStore &&
          data.scope === "one-to-one" &&
          (data.streamReplies?.oneOnOne ?? true);
        let lastStreamWrite = 0;
        const onDelta = streamOneOnOne
          ? (full: string) => {
              const nowMs = Date.now();
              if (nowMs - lastStreamWrite < 900) return; // throttle to ~1s writes
              lastStreamWrite = nowMs;
              void turnStore!
                .updateTurnReplies(
                  turnId!,
                  [...replies, { agentId: winner.id, text: full }],
                  buildResumeState(),
                )
                .catch(() => {});
            }
          : undefined;

        const personaArgs = {
          model: usedModel,
          instructions,
          fastMode: routerCfg.fastMode,
          tools: mergedTools.length > 0 ? mergedTools : undefined,
          onToolCall: (c: { name: string; arguments: Record<string, unknown> }) =>
            runToolSafely(c.name, () => combinedOnToolCall(c)),
          toolChoice,
          maxToolHops: 5,
          // Route this agent's requests to its own cached prefix (stable snapshot/tools/roster).
          promptCacheKey: `huddle-${winner.id}`,
          ...(personaReasoningEffort ? { reasoningEffort: personaReasoningEffort } : {}),
          ...(streamOneOnOne ? { stream: true, onDelta } : {}),
          signal,
        };
        let persona: { text: string; reasoning: string[] };
        try {
          persona = await callOpenAIResponses({
            ...personaArgs,
            transcript: personaTranscript,
            ...(conversationId ? { conversation: conversationId } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Self-heal a POISONED conversation object: a tool/function call was stored in the OpenAI
          // conversation thread but its output never got submitted (turn hit maxHops / the deadline /
          // aborted mid-hop), so every later turn 400s "No tool output found for function call …".
          // Drop the conversation (re-mints fresh next turn) and retry THIS turn with the full
          // reconstructed transcript and NO conversation object, so the user still gets a reply now.
          if (conversationId && /No tool output found for function call/i.test(msg)) {
            const { clearConversationId } = await import("./rag/conversation-store.server");
            await clearConversationId({ userEmail: conversationEmail, huddleId: data.huddleId, agentId: winner.id });
            console.warn(
              `[huddle-memory] poisoned conversation for ${winner.id} in ${data.huddleId} — cleared; retrying with reconstruction.`,
            );
            persona = await callOpenAIResponses({ ...personaArgs, transcript });
          } else {
            throw err;
          }
        }
        clean = persona.text.trim();
        if (persona.reasoning.length > 0) {
          reasoningSummaries.push(...persona.reasoning.map((r) => `${winner.name}: ${r}`));
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
            date: z.string().optional(),
          }),
          execute: async (args) =>
            JSON.stringify(await createSuggestedTaskFromTool(args as Record<string, unknown>)),
        });

        // create_huddle_tasks — batch multi-task create (mirrors the OpenAI path). Use for >1 task.
        lovableTools.create_huddle_tasks = tool({
          description:
            "Create MULTIPLE tasks at once. Use this — NOT repeated create_huddle_task calls — whenever the user asks for more than one task in a single message. Each is added to the Huddle board and, when journey is connected, created + co-scheduled on their journey board in one pass. The result reports EXACTLY how many were created — report that number, never assume all landed.",
          inputSchema: z.object({
            tasks: z.array(z.string()),
            date: z.string().optional(),
          }),
          execute: async (args) =>
            JSON.stringify(await createBatchTasksFromTool(args as Record<string, unknown>)),
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
            const taskIdRaw = a.task_id ? String(a.task_id) : "";
            if (!name || !content)
              return JSON.stringify({ ok: false, error: "name and content are required" });
            let revisionCountForClaim = 0;
            if (taskIdRaw) {
              try {
                const { getTaskEngagementState } = await import("./tasks/tasks.server");
                revisionCountForClaim =
                  (await getTaskEngagementState(taskIdRaw))?.revision_count ?? 0;
              } catch {
                /* default 0 */
              }
            }
            if (!claimAction(`create_artifact:${taskIdRaw}:${name}:${revisionCountForClaim}`)) {
              recordToolUse(
                winner.id,
                "create_artifact",
                "already saved this turn — skipped duplicate",
                true,
              );
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
                taskId: taskIdRaw || null,
                folder: String(a.folder ?? "Research"),
                name,
                mime: String(a.mime ?? "text/markdown"),
                bytes: Buffer.from(content, "utf8"),
              });
              let reviewSuffix = "";
              let review:
                { proceed: boolean; message: string; deficiencies?: string[] } | undefined;
              if (taskIdRaw) {
                const { runReviewGate } = await import("./tasks/review-gate.server");
                const gate = await runReviewGate({
                  taskId: taskIdRaw,
                  agentId: winner.id,
                  email,
                  content,
                  claim: claimAction,
                });
                if (gate.proceed) {
                  const { ensureReviewFlip } = await import("./tasks/tasks.server");
                  const flip = await ensureReviewFlip(taskIdRaw, email, data.caller, winner.id);
                  if (flip.pendingConfirm) {
                    reviewSuffix =
                      " · saved, but held out of review — confirm intent with the user first";
                    review = {
                      proceed: false,
                      message:
                        "Your work is saved, but this task can't move to the user's review queue yet: you never confirmed the Definition of Done with them. Send them the confirm-intent ask now (what you believe they wanted + the DoD, and ask them to confirm/correct it), then call confirm_task_intent once they reply.",
                    };
                  }
                }
                if (gate.gated) {
                  reviewSuffix = ` · ${gate.note}`;
                  review = {
                    proceed: gate.proceed,
                    message: gate.proceed
                      ? "Review passed — this is now in the user's review queue."
                      : `Sent back for one revision before it can move to review: ${(gate.deficiencies ?? []).join("; ")}. Address these and call create_artifact again with the same task_id and name to resave.`,
                    deficiencies: gate.deficiencies,
                  };
                }
              }
              recordToolUse(
                winner.id,
                "create_artifact",
                `saved "${name}"${reviewSuffix}`,
                true,
                deepLink,
              );
              return JSON.stringify({ ok: true, id, deepLink, ...(review ? { review } : {}) });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "create_artifact", "save failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });

        // delegate_to_specialist — hand a workstream to a shared worker (mirrors OpenAI path).
        lovableTools.delegate_to_specialist = tool({
          description: DELEGATE_TO_SPECIALIST_TOOL.description,
          inputSchema: z.object({
            role: z.string(),
            objective: z.string(),
            inputs: z.string().optional(),
            acceptance_criteria: z.string().optional(),
          }),
          execute: async (args) => dispatchDelegate(args as Record<string, unknown>),
        });

        // flag_blocker — the agent earns the "blocked" verdict by working the task (mirrors OpenAI path).
        lovableTools.flag_blocker = tool({
          description: FLAG_BLOCKER_TOOL.description,
          inputSchema: z.object({ task_id: z.string(), reason: z.string() }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const reason = String(a.reason ?? "").trim();
            if (!taskId || !reason)
              return JSON.stringify({ ok: false, error: "task_id and reason are required" });
            if (!claimAction(`flag_blocker:${taskId}`)) {
              recordToolUse(
                winner.id,
                "flag_blocker",
                "already flagged this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({ ok: true, deduped: true });
            }
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              // Journey status=BLOCKED FIRST, and gate the reason-record on it (mirrors the OpenAI path):
              // a bad/stale task_id must not leave an orphan blocker row or let the agent claim a phantom
              // block. This path previously ignored the journey result entirely.
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
                if (!r.ok)
                  boardError = String(r.error ?? r.output ?? "update_task_failed").slice(0, 160);
              } catch (e) {
                boardError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
              }
              if (!boardStatusSet) {
                recordToolUse(
                  winner.id,
                  "flag_blocker",
                  `could not block — board not updated: ${boardError}`,
                  false,
                  boardError || undefined,
                );
                return JSON.stringify({
                  ok: false,
                  task_id: taskId,
                  board_status_set: false,
                  error: `Could not mark the task blocked (${boardError}). Do NOT tell the user it is blocked — say you could not flag it and confirm the exact task with them.`,
                });
              }
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

        // propose_task_intent — record the PROPOSED DoD at ask-time, before the user replies (mirrors
        // the OpenAI path). Distinct from confirm_task_intent below; never touches confirm_status.
        lovableTools.propose_task_intent = tool({
          description: PROPOSE_TASK_INTENT_TOOL.description,
          inputSchema: z.object({
            task_id: z.string(),
            task_title: z.string(),
            definition_of_done: z.string(),
          }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const taskTitle = String(a.task_title ?? "").trim();
            const dod = String(a.definition_of_done ?? "").trim();
            if (!taskId || !dod)
              return JSON.stringify({
                ok: false,
                error: "task_id and definition_of_done are required",
              });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { proposeTaskDod } = await import("./tasks/tasks.server");
              await proposeTaskDod(taskId, email, dod);
              recordToolUse(
                winner.id,
                "propose_task_intent",
                `Proposed DoD for "${taskTitle || taskId}"`,
                true,
                JSON.stringify({ taskId, taskTitle, proposedDod: dod }),
              );
              return JSON.stringify({ ok: true, task_id: taskId });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "propose_task_intent", "propose failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });

        // confirm_task_intent — lock in the confirmed DoD (mirrors the OpenAI path).
        lovableTools.confirm_task_intent = tool({
          description: CONFIRM_TASK_INTENT_TOOL.description,
          inputSchema: z.object({ task_id: z.string(), definition_of_done: z.string() }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const dod = String(a.definition_of_done ?? "").trim();
            if (!taskId || !dod)
              return JSON.stringify({
                ok: false,
                error: "task_id and definition_of_done are required",
              });
            if (!claimAction(`confirm_task_intent:${taskId}`)) {
              recordToolUse(
                winner.id,
                "confirm_task_intent",
                "already confirmed this turn — skipped duplicate",
                true,
              );
              return JSON.stringify({ ok: true, deduped: true });
            }
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { confirmTaskIntent } = await import("./tasks/tasks.server");
              await confirmTaskIntent(taskId, email, dod);
              let journeySet = false;
              try {
                const { invokeJourneyTool } = await import("./journey/proxy.functions");
                const r = await invokeJourneyTool({
                  toolName: "update_task",
                  args: { task_id: taskId, definition_of_done: dod },
                  caller: data.caller ?? {},
                  context: { source: "huddle" },
                });
                journeySet = !!r.ok;
              } catch {
                /* non-fatal — the confirmed DoD is already durable in task_engagement_state */
              }
              recordToolUse(
                winner.id,
                "confirm_task_intent",
                journeySet ? "DoD confirmed" : "DoD confirmed, journey write failed",
                true,
              );
              return JSON.stringify({ ok: true, task_id: taskId, journey_set: journeySet });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "confirm_task_intent", "confirm failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });

        // propose_approach — pre-work approach gate (mirrors the OpenAI path).
        lovableTools.propose_approach = tool({
          description: PROPOSE_APPROACH_TOOL.description,
          inputSchema: z.object({ task_id: z.string(), approach: z.string() }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const approach = String(a.approach ?? "").trim();
            if (!taskId || !approach)
              return JSON.stringify({ ok: false, error: "task_id and approach are required" });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { getTaskTitle } = await import("./tasks/tasks.server");
              const title = await getTaskTitle(taskId);
              const { runApproachGate } = await import("./tasks/approach-gate.server");
              const gate = await runApproachGate({
                taskId,
                agentId: winner.id,
                email,
                taskTitle: title,
                approach,
                claim: claimAction,
              });
              recordToolUse(
                winner.id,
                "propose_approach",
                gate.approved
                  ? "approach approved"
                  : gate.escalated
                    ? "approach escalated to user"
                    : `sent back — ${gate.note}`,
                true,
              );
              return JSON.stringify({
                ok: true,
                approved: gate.approved,
                escalated: gate.escalated,
                note: gate.note,
                ...(gate.deficiencies ? { deficiencies: gate.deficiencies } : {}),
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "propose_approach", "approach gate failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });

        // ask_clarifying_question / resolve_clarifying_question — bounded mid-work Q&A (mirrors the OpenAI path).
        lovableTools.ask_clarifying_question = tool({
          description: ASK_CLARIFYING_QUESTION_TOOL.description,
          inputSchema: z.object({ task_id: z.string(), question: z.string() }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            const question = String(a.question ?? "").trim();
            if (!taskId || !question)
              return JSON.stringify({ ok: false, error: "task_id and question are required" });
            try {
              const email =
                (await (await import("./journey/identity")).resolveTaskEmail(data.caller)) ??
                data.caller?.entra_email;
              if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
              const { getTaskEngagementState, openClarifyingQuestion } =
                await import("./tasks/tasks.server");
              const { getWorkflowCaps } = await import("./identity/agent-workflow-config.server");
              const state = await getTaskEngagementState(taskId);
              if (state?.clarify_status === "open") {
                recordToolUse(
                  winner.id,
                  "ask_clarifying_question",
                  "already has an open question — wait for the reply",
                  false,
                );
                return JSON.stringify({
                  ok: false,
                  error:
                    "This task already has an open question awaiting the user's reply — wait for their answer before asking another.",
                });
              }
              const caps = await getWorkflowCaps(email, winner.id).catch(() => ({
                approach: 3,
                review: 3,
                question: 2,
              }));
              const currentCount = state?.clarify_count ?? 0;
              if (currentCount >= caps.question) {
                recordToolUse(
                  winner.id,
                  "ask_clarifying_question",
                  `cap reached (${caps.question})`,
                  false,
                );
                return JSON.stringify({
                  ok: false,
                  error: `You've already asked the max (${caps.question}) clarifying questions on this task. Proceed on your best judgment, or call flag_blocker if you genuinely cannot continue.`,
                });
              }
              const count = await openClarifyingQuestion(taskId, email, question);
              recordToolUse(
                winner.id,
                "ask_clarifying_question",
                `asked (${count}/${caps.question}): ${question.slice(0, 80)}`,
                true,
              );
              return JSON.stringify({ ok: true, task_id: taskId, count, cap: caps.question });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "ask_clarifying_question", "ask failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });
        lovableTools.resolve_clarifying_question = tool({
          description: RESOLVE_CLARIFYING_QUESTION_TOOL.description,
          inputSchema: z.object({ task_id: z.string() }),
          execute: async (args) => {
            const a = args as Record<string, unknown>;
            const taskId = String(a.task_id ?? "").trim();
            if (!taskId) return JSON.stringify({ ok: false, error: "task_id is required" });
            try {
              const { closeClarifyingQuestion } = await import("./tasks/tasks.server");
              await closeClarifyingQuestion(taskId);
              recordToolUse(winner.id, "resolve_clarifying_question", "resumed", true);
              return JSON.stringify({ ok: true });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              recordToolUse(winner.id, "resolve_clarifying_question", "resolve failed", false, msg);
              return JSON.stringify({ ok: false, error: msg });
            }
          },
        });

        // schedule_reminder — Huddle-native timed reminder (mirrors the OpenAI path).
        {
          const { dispatchScheduleReminder, SCHEDULE_REMINDER_TOOL: RTOOL } =
            await import("./tasks/reminders");
          lovableTools.schedule_reminder = tool({
            description: RTOOL.description,
            inputSchema: z.object({
              text: z.string(),
              delay_minutes: z.number().optional(),
              at_time: z.string().optional(),
            }),
            execute: async (args) => {
              const a = args as Record<string, unknown>;
              if (
                !claimAction(`reminder:${a.text ?? ""}:${a.delay_minutes ?? ""}:${a.at_time ?? ""}`)
              ) {
                recordToolUse(
                  winner.id,
                  "schedule_reminder",
                  "already scheduled this turn — skipped duplicate",
                  true,
                );
                return JSON.stringify({
                  ok: true,
                  deduped: true,
                  message: "That reminder was already scheduled this turn.",
                });
              }
              const out = await dispatchScheduleReminder(
                data.caller,
                a,
                data.huddleId,
                winner.id,
                data.timeZone,
              );
              const ok = !JSON.parse(out).error;
              recordToolUse(
                winner.id,
                "schedule_reminder",
                ok ? "reminder scheduled" : "reminder · failed",
                ok,
              );
              return out;
            },
          });
        }

        // schedule_and_priorities — shared schedule/priorities tool (mirrors the OpenAI path).
        {
          const { dispatchPrioritize } = await import("./tasks/tools");
          lovableTools.schedule_and_priorities = tool({
            description:
              "The user's schedule + tasks: their nightly-planned schedule (scheduled items for a day) plus their open tasks/backlog, ranked by priority, due dates, and staleness. Call it for ANY question about the user's schedule, calendar, agenda, day, meetings, tasks, backlog, priorities, or what's next. Use view 'scheduled' for 'what's on my schedule/calendar/day today'. (Only an explicit 'external/Outlook calendar' ask uses get_calendar_events instead.)",
            inputSchema: z.object({
              view: z.enum(["priorities", "backlog", "up_next", "scheduled", "overdue"]).optional(),
              category: z.string().optional(),
              limit: z.number().optional(),
            }),
            execute: async (args) => {
              const ident = await (
                await import("./journey/identity")
              ).resolveJourneyIdentity(data.caller, data.timeZone);
              return dispatchPrioritize(
                ident.email ?? data.caller?.entra_email,
                args as Record<string, unknown>,
                ident.timeZone || data.timeZone || "UTC",
              );
            },
          });
          // Calendar-framed ALIAS → the SAME combined-schedule executor (view 'scheduled'). One place
          // to update; "what's on my calendar" returns the combined schedule, never raw Outlook.
          lovableTools.get_calendar_events = tool({
            description:
              "The user's calendar / day / schedule — their COMBINED nightly schedule (tasks + calendar), the source of truth. Use for 'what's on my calendar/schedule/agenda/day', meetings, or appointments. (For the RAW external Outlook calendar specifically, use get_external_calendar_events.)",
            inputSchema: z.object({ category: z.string().optional() }),
            execute: async (args) => {
              const ident = await (
                await import("./journey/identity")
              ).resolveJourneyIdentity(data.caller, data.timeZone);
              return dispatchPrioritize(
                ident.email ?? data.caller?.entra_email,
                { view: "scheduled", ...(args as Record<string, unknown>) },
                ident.timeZone || data.timeZone || "UTC",
              );
            },
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
            inputSchema: z.object({
              category: z.string().optional(),
              limit: z.number().optional(),
            }),
            execute: async (args) =>
              dispatchGroomBacklog(data.caller, args as Record<string, unknown>),
          });
        }

        // Native Huddle email via Microsoft Graph (mirrors the OpenAI path).
        {
          const { emailFromOptions, graphEmailConfigured } =
            await import("./email/graph-email.server");
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
                  recordToolUse(
                    winner.id,
                    "send_email",
                    "already sent this turn — skipped duplicate",
                    true,
                  );
                  return JSON.stringify({
                    ok: true,
                    deduped: true,
                    message: "That email was already sent this turn.",
                  });
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
                  recordToolUse(
                    winner.id,
                    "create_email_draft",
                    "already drafted this turn — skipped duplicate",
                    true,
                  );
                  return JSON.stringify({
                    ok: true,
                    deduped: true,
                    message: "That draft was already created this turn.",
                  });
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
            lovableTools.get_external_calendar_events = tool({
              description:
                "Read the user's RAW EXTERNAL Microsoft/Outlook calendar. RARE — only when the user explicitly asks for their external/Outlook/Microsoft calendar. For 'what's on my calendar/schedule/day', use get_calendar_events instead. Reads REAL data; Microsoft/Outlook events only.",
              inputSchema: z.object({
                start: z.string().optional(),
                end: z.string().optional(),
              }),
              execute: async (args) => {
                const a = args as Record<string, unknown>;
                const tz = data.timeZone || "UTC";
                const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
                const startRaw =
                  typeof a.start === "string" && a.start.trim() ? a.start.trim() : todayStr;
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
                  "get_external_calendar_events",
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
                    const defer = await maybeDeferStatusChange(def.name, args);
                    if (defer) {
                      recordToolUse(
                        winner.id,
                        def.name,
                        `deferred — task assigned to ${defer.assignedTo}, not ${winner.id}`,
                        true,
                      );
                      return JSON.stringify(defer);
                    }
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
            "\n\n" +
            PRIORITIZE_SYSTEM_HINT +
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
        // E (F13): emit a tool-START marker for the Lovable backend too (the OpenAI path hooks this in
        // combinedOnToolCall). Wrap each tool's execute ONCE so the client's progress narration covers
        // both engines. Purely additive — it calls the original execute unchanged; no-op outside a run.
        for (const name of toolNames) {
          const t = lovableTools[name] as { execute?: (...a: unknown[]) => unknown };
          const orig = t.execute;
          if (typeof orig === "function") {
            t.execute = (...args: unknown[]) => {
              trackCeremonyToolStart(winner.id, name);
              return orig(...args);
            };
          }
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
          recordToolUse(
            winner.id,
            "schedule_reminder",
            "offered (forced — reminder request)",
            true,
          );
        } else if (forceTaskCreation && lovableTools.create_huddle_task) {
          recordToolUse(winner.id, "create_huddle_task", "offered (forced — task request)", true);
        } else if (forceWebSearch && lovableTools.tavily_web_search) {
          recordToolUse(winner.id, "tavily_web_search", "offered (forced — time-sensitive)", true);
        }

        const { text } = await generateText({
          model,
          system: usedInstructions,
          // The Lovable/AI-SDK path takes string content only (its multi-modal part shape differs from the
          // OpenAI Responses `input_image` form used above). Attachment vision is an OpenAI-backend feature,
          // so flatten any image parts to a text note here; inline-file text is already in the string. ACT-45.
          messages: transcript.map((t) => ({
            role: t.role,
            content:
              typeof t.content === "string"
                ? t.content
                : t.content
                    .map((p) => (p.type === "input_text" ? (p.text ?? "") : "[the user attached an image]"))
                    .join("\n"),
          })),
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
          abortSignal: signal,
        });
        clean = text.trim();
      }

      if (!clean) {
        // D (F12): a CEREMONY BARGE responder that RAN a real tool but produced no spoken text must
        // NOT go silent — instead of skipping, emit an honest ack+deferral so the user always hears a
        // response after their interjection. Only real executions count (exclude the offering log
        // `tool_catalog` and the "offered (forced …)" pre-records, which aren't tool runs).
        const ranRealTool = toolUses.some(
          (t) => t.tool !== "tool_catalog" && !/^offered\b/i.test(t.summary),
        );
        if (turnBargeDirective && ranRealTool) {
          return bundle({
            kind: "reply",
            clean: bargeToolDeferralText(),
            isInterjector: false,
            perAgentFallbacks,
          });
        }
        return bundle({ kind: "skip" });
      }

      // Persist prompt debug for this reply.
      prompts.push({
        agentId: winner.id,
        backend: usedBackend,
        model: usedModel,
        instructions: usedInstructions,
        fromSnapshot,
        toolTypes,
        difficulty: usedDifficulty,
        effort: usedEffort,
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
  const mergeAgentResult = (nextId: AgentId, r: AgentTurnResult, waveIds: readonly AgentId[]) => {
    const winner = AGENT_BY_ID[nextId]!;
    // Append-only buffers merge deterministically (queue order via call order).
    fallbacks.push(...r.fallbacks);
    toolUses.push(...r.toolUses);
    journeyTaskUpdates.push(...r.journeyTaskUpdates);
    suggestedTasks.push(...r.suggestedTasks);
    reasoningSummaries.push(...r.reasoning);
    prompts.push(...r.prompts);

    const outcome = r.outcome;
    if (outcome.kind === "skip") {
      // A runBounded deadline race: shiftEligible() already removed this agent from `queue` to
      // build the wave, and it's deliberately never marked `spoken` (see below) — but with
      // nothing re-adding it, it simply vanished from the turn's bookkeeping instead of being
      // retried. If EVERY invited agent times out in the same wave, the turn finalizes DONE with
      // zero replies even though real work (a tool call) may have already succeeded — exactly the
      // "heads-up notification but nothing in chat" symptom. In CHUNKED mode, re-queue it for a
      // later chunk with a fresh budget. A genuinely empty completion (not a timeout) is NOT
      // re-queued — the model already finished and chose to say nothing; retrying would just
      // repeat that, wasting a chunk.
      if (outcome.timedOut && chunked) queue.push(nextId);
      return; // produced nothing (no reply, not spoken)
    }
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

    // Attach any artifacts this agent saved this turn so the chat bubble can render an "Open <name>"
    // chip. Derived from its toolUses (create_artifact stores deepLink `/artifacts/<id>` in detail and
    // `saved "<name>"` in summary) — already serialized through resume/chunk/durable paths, so no new
    // per-agent buffer to thread. The client opens by id (fresh SAS), so this survives SAS expiry.
    const replyArtifacts = r.toolUses
      .filter(
        (t) =>
          t.tool === "create_artifact" &&
          t.ok &&
          typeof t.detail === "string" &&
          t.detail.startsWith("/artifacts/"),
      )
      .map((t) => ({
        id: (t.detail as string).slice("/artifacts/".length),
        name: /saved "(.+)"/.exec(t.summary)?.[1] ?? "Document",
      }));
    // Pillar 2: a delegation INTEGRATION turn references specialist docs its WORKERS produced (this
    // persona didn't call create_artifact for them), so surface them as chips too — but only on the
    // target persona's reply, and dedup against anything it did save itself.
    if (data.attachArtifacts?.length && nextId === data.targetAgentId) {
      const seen = new Set(replyArtifacts.map((a) => a.id));
      for (const a of data.attachArtifacts) {
        if (!seen.has(a.id)) {
          replyArtifacts.push({ id: a.id, name: a.name });
          seen.add(a.id);
        }
      }
    }
    // Backstop the fabricated-document-link failure (even when a REAL artifact was saved, the model may
    // still hand-author a fake/placeholder link in prose). The chip is the only real document link; strip
    // any self-authored markdown link from the text so the user never sees a fake "open the document" link.
    // Also backstop file_search's own narration tendency (house-style bans it in prose; the model still
    // does it — see stripFileMentionNarration above).
    const safeText = stripFileMentionNarration(stripAgentReplyLinks(finalText));
    // A confirm-intent ask this reply IS, if the agent called propose_task_intent this same turn — mirrors
    // replyArtifacts's derivation exactly (detail carries the structured payload as JSON rather than a
    // path, since there's no natural id/path shape here). Deliberately NOT the attachArtifacts/
    // targetAgentId injection mechanism: unlike a delegation-produced artifact chip (attached to a
    // DIFFERENT agent's reply than the one that made it), a confirm-ask always belongs to the SAME agent's
    // OWN turn that sent it, so deriving from this agent's own toolUses is the correct-scoped mechanism.
    let replyConfirmAsk: { taskId: string; taskTitle: string; proposedDod: string } | undefined;
    const confirmAskToolUse = r.toolUses.find(
      (t) => t.tool === "propose_task_intent" && t.ok && typeof t.detail === "string",
    );
    if (confirmAskToolUse) {
      try {
        const parsed = JSON.parse(confirmAskToolUse.detail as string) as {
          taskId?: unknown;
          taskTitle?: unknown;
          proposedDod?: unknown;
        };
        if (typeof parsed.taskId === "string" && typeof parsed.proposedDod === "string") {
          replyConfirmAsk = {
            taskId: parsed.taskId,
            taskTitle: typeof parsed.taskTitle === "string" ? parsed.taskTitle : "",
            proposedDod: parsed.proposedDod,
          };
        }
      } catch {
        /* malformed detail -> no confirmAsk chip this reply; never breaks the turn */
      }
    }
    replies.push({
      agentId: nextId,
      text: safeText,
      fallbackNotes: outcome.perAgentFallbacks.length > 0 ? outcome.perAgentFallbacks : undefined,
      artifacts: replyArtifacts.length ? replyArtifacts : undefined,
      confirmAsk: replyConfirmAsk,
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
        handoffById.set(id, {
          fromName: winner.name,
          ask: clean.replace(/\s+/g, " ").trim().slice(0, 300),
        });
      }
    }

    // 1:1 owner follow-up (AC-4) — DETERMINISTIC back-channel, no @-parsing. In a DM, resolve the
    // owner of the USER's ask from data (capability triggers for exclusive tools, else the domain/theme
    // lane owner). If that owner isn't the addressed agent, enqueue a backend turn so they reply in
    // THEIR OWN DM — which fires the existing away-notification. Once per owner per turn; 1:1 only
    // (group turns bring the owner in via the normal re-queue above).
    // Only for a GENUINE user 1:1 message. Internal turns (autowork/standup/grooming/a prior
    // follow-up/an integration) carry a directive as their `text`; running this on them mis-resolves a
    // lane owner and spawns follow-ups that chain into a notification barrage (measured: autowork→Liam
    // →Sam loop; Terry→Cole→Iris→Ezra chain). Gating on !data.internal confines the pass-along to real
    // user asks and stops a follow-up from ever spawning another follow-up.
    // Intent-gated: only fire when the user is actually requesting an action to be PERFORMED — not
    // when confirming completion, querying ownership, acknowledging, or informing. Recomputed here
    // (classifyTurnIntent is a pure function of data.text) — the laneDirective guard's `turnIntent`
    // above is declared in a different loop's block scope and isn't visible at this point.
    const followupTurnIntent = TURN_INTENT_CLASSIFICATION
      ? classifyTurnIntent(data.text)
      : "perform";
    if (data.scope !== "group" && !data.internal && followupTurnIntent === "perform") {
      // Owner resolution is SEMANTIC in a 1:1 (the LLM router is group-only). capabilityOwnerFor
      // (exclusive powers) is authoritative + synchronous — deliver it immediately, exactly as before.
      const capOwnerId = capabilityOwnerFor(data.text)?.agent.id ?? null;
      const deliverIfOwner = (ownerId: AgentId | null) => {
        if (ownerId && ownerId !== nextId && !followupDelivered.has(ownerId)) {
          followupDelivered.add(ownerId);
          void deliverOwnerFollowup(ownerId, winner.name, data.text);
        }
      };
      if (capOwnerId) {
        deliverIfOwner(capOwnerId);
      } else {
        // No exclusive owner → resolve the LANE owner. The LLM router doesn't run in a 1:1, so classify
        // SEMANTICALLY (a cheap dedicated LLM call, mirroring scoreDifficultyLLM) — replacing the keyword
        // laneOwnerFor that mis-routed a finance spreadsheet to the product lane on "build a spreadsheet".
        // Fire-and-forget (same as the existing deliverOwnerFollowup pattern here) so it never delays the
        // user's reply; falls back to the keyword laneOwnerFor on no-key/failure so it's never worse.
        void (async () => {
          // The semantic resolver is AUTHORITATIVE when it succeeds: it returns a real owner id — which
          // may be the ADDRESSED agent, meaning "keep it here" — and returns null ONLY on failure/no-key.
          // So fall back to the keyword laneOwnerFor ONLY on that null; never override a real decision
          // (the earlier bug: null meant BOTH "keep" and "failed", so laneOwnerFor re-introduced the mis-route).
          const resolved =
            routerCfg.backend === "openai" && openaiKey
              ? await resolveOwnerLLM(data.text, nextId, {
                  backend: "openai",
                  model: routerCfg.model,
                  fastMode: routerCfg.fastMode,
                })
              : null;
          const ownerId = resolved ?? (laneOwnerFor(data.text, nextId)?.id ?? null);
          deliverIfOwner(ownerId);
        })();
      }
    }
  };

  // The frozen anti-repetition anchor for the NEXT agent(s) to run: every reply
  // merged so far, in order. Recomputed once per wave and shared by all agents
  // in that wave (they do not see each other's replies).
  const buildPrior = () =>
    replies.map((rep) => `${AGENT_BY_ID[rep.agentId].name} just said: "${rep.text}"`).join("\n");

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
  const runBounded = (
    id: AgentId,
    prior: string,
    userTextOverride?: string,
  ): Promise<AgentTurnResult> => {
    const floor = chunked ? 8_000 : 2_000;
    // A 1:1 has a single responding agent — there is no wave to protect from a straggler, so give it
    // (nearly) the whole hosting request instead of the shared chunk/turn slice. This is what lets a
    // slow high-effort (Sol) 1:1 reply finish instead of being cut; if it STILL overruns, the streamed
    // partial is already persisted and the durable turn continues in a fresh execution.
    const budgetMs = data.scope === "one-to-one" ? 40_000 : deadlineMs;
    const remaining = Math.max(floor, budgetMs - (Date.now() - turnStartMs));
    // Tied to the timeout below: when the deadline fires we don't just stop WAITING on the agent's
    // call, we actually tell it to stop. Without this, an "abandoned" attempt keeps running in the
    // background (a zombie) with no cancellation, can still fire real tool calls no one is tracking,
    // and a later retry then finds its own predecessor's mutations and reports them as pre-existing —
    // ground-truthed live: Finn told the user "0 new tasks were created; all four already have board
    // cards" when 3 of the 4 had in fact just been created by his own earlier, timed-out attempt in
    // this exact turn, 40s before that reply.
    const controller = new AbortController();
    const attempt = runAgentTurn(id, prior, userTextOverride, controller.signal);
    // The abort() below makes this settle (usually reject with an AbortError) after the race has
    // already resolved via the timeout branch. Nobody awaits `attempt` past that point — swallow it
    // here so an aborted/failed zombie doesn't surface as an unhandled promise rejection.
    attempt.catch(() => {});
    return Promise.race([
      attempt,
      new Promise<AgentTurnResult>((resolve) =>
        setTimeout(() => {
          controller.abort();
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
            outcome: { kind: "skip", timedOut: true },
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
    ceremonyCloser,
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

  // Residual safety net for a turn finalizing with ZERO replies. The re-queue above (see the skip
  // branch in mergeAgentResult) should catch the common case, but a turn can still exhaust
  // MAX_CHUNKS with every agent timing out repeatedly. If a tool call already succeeded this turn
  // (e.g. a task was created — the push notification for it already fired), don't let the turn go
  // out in total silence: that is exactly the "heads-up but nothing in chat" symptom the user hit.
  // Attributed to whichever agent actually ran the tool, not a synthetic system voice.
  const ensureNotSilentOnRealWork = () => {
    if (replies.length > 0) return;
    const didWork = toolUses.find((t) => t.ok && t.tool !== "tool_catalog");
    if (!didWork) return;
    replies.push({
      agentId: didWork.agentId,
      text:
        `${didWork.summary} — I ran out of time to reply in full, but that went through. ` +
        `Let me know if you want more detail.`,
    });
  };

  // "researched" mode, GROUP/ceremony only (1:1 is carried by the conversation object): after the turn,
  // persist (A1) a distilled record of each agent's reply as a shared episodic chunk attributed to that
  // agent — so what an agent SAID survives beyond the ~14-message window and is retrievable cross-huddle —
  // and (tool-confirmed triples) extract canonical facts ONLY from an agent's successful tool outcomes
  // (never free-form text, so a hallucination can't become a fact-of-record), superseding older values.
  // Fire-and-forget: the reply has already returned; a failure here never affects the turn.
  let researchedMemPersisted = false;
  function persistResearchedMemory() {
    if (researchedMemPersisted) return;
    researchedMemPersisted = true;
    if (data.memoryMode !== "researched" || data.scope === "one-to-one" || !openaiKey) return;
    const anyShared = data.members.some((id) => {
      const c = agentsCfg[id]?.rag;
      return c?.store === "azure" && c.chunks && (c.sharing ?? "shared") === "shared";
    });
    if (!anyShared) return; // respect privacy: only persist when the room shares memory
    const finalReplies = [...replies];
    const finalTools = [...toolUses];
    (async () => {
      try {
        const { azurePgStore } = await import("./rag/azure-pg.server");
        const { embed } = await import("./rag/embed.server");
        const { extractTriples } = await import("./rag/triples.server");
        const src = `huddle:${data.huddleId}`;
        // A1 — distilled agent-reply chunks
        for (const r of finalReplies) {
          const gist = String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
          if (gist.length < 12) continue;
          const name = AGENT_BY_ID[r.agentId]?.name ?? r.agentId;
          const text = `${name} said: ${gist}`;
          let vec: number[] | null = null;
          try {
            vec = await embed(text);
          } catch {
            vec = null;
          }
          if (!vec) continue;
          await azurePgStore.writeChunk({
            scope: "global",
            text,
            source: src,
            embedding: vec,
            authorAgentIds: [r.agentId],
          });
        }
        // Tool-confirmed triples — canonical facts an agent actually established (ok:true only)
        for (const t of finalTools) {
          if (!t.ok || !t.summary) continue;
          const name = AGENT_BY_ID[t.agentId]?.name ?? t.agentId;
          let facts: { subject: string; predicate: string; object: string; confidence: number }[] = [];
          try {
            facts = await extractTriples(`${name} ${t.tool}: ${t.summary}`);
          } catch {
            facts = [];
          }
          if (facts.length) {
            await azurePgStore.writeTriples(
              facts.map((f) => ({
                scope: "global" as const,
                subject: f.subject,
                predicate: f.predicate,
                object: f.object,
                confidence: f.confidence,
                authorAgentIds: [t.agentId],
                supersede: true,
              })),
            );
          }
        }
      } catch (e) {
        console.error("[researched-mem] persist failed", e instanceof Error ? e.message : e);
      }
    })();
  }

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
    // BARGE-IN: drain any user interjections queued on this turn (bargeCeremony appended them). Runs
    // BETWEEN speakers — never mid-speaker — so a stand-up pauses politely for a question, answers
    // it, then resumes the round-robin. Each barge is routed to the addressed/most-relevant agent
    // (host fallback), dispatched with a barge directive so it answers the user (and can file a task)
    // instead of giving its lane update. Claim is atomic + row-locked, so a resumed chunk can't
    // re-handle it. Answering an owner's barge does NOT consume their round-robin slot.
    const handleBarges = async () => {
      if (!chunked || !turnId || !turnStore) return;
      for (;;) {
        if (replies.length >= replyCap) return;
        const claimed = await turnStore.claimBarge(turnId);
        if (!claimed) return;
        const mentioned = parseMentions(claimed.text, AGENTS).filter((id) =>
          data.members.includes(id),
        );
        const routedBarge = routeMessage({
          text: claimed.text,
          scope: "group",
          members: data.members,
          history: [],
        });
        const responder =
          mentioned[0] ??
          routedBarge.winners.find((id) => data.members.includes(id)) ??
          (data.members.includes(CEREMONY_HOST) ? CEREMONY_HOST : null);
        if (responder && AGENT_BY_ID[responder]) {
          const wasSpoken = spoken.has(responder);
          const stillQueued = queue.includes(responder);
          bargeDirectiveById.set(responder, bargeDirective(claimed.text));
          const r = await runBounded(responder, buildPrior(), claimed.text);
          mergeAgentResult(responder, r, [responder]);
          bargeDirectiveById.delete(responder);
          // Don't burn the responder's own round-robin turn: if they hadn't spoken their lane update
          // yet (still queued), let them still give it after the interjection is handled.
          if (stillQueued && !wasSpoken) spoken.delete(responder);
          await streamChunk();
        }
        if (chunkBudgetHit()) return;
      }
    };

    // Ceremonies stay STRICTLY SEQUENTIAL: each participant (lane owners, then
    // the host/closer) speaks in turn seeing everything said before it.
    while (replies.length < replyCap) {
      // Chunked: once the budget is spent, stop and let the runner continue the ceremony next chunk
      // (participants stay in `queue`). The host-closes-last ordering is preserved because the queue
      // order is preserved across the boundary.
      if (chunkBudgetHit() && queue.length > 0) break;
      await handleBarges(); // answer any interjection BEFORE the next scheduled speaker
      if (chunkBudgetHit() && queue.length > 0) break;
      const nextId = shiftEligible();
      if (nextId == null) break;
      const r = await runBounded(nextId, buildPrior());
      mergeAgentResult(nextId, r, [nextId]);
      await streamChunk();
    }
    // A barge could land after the last owner but before the close — handle it, then Terry closes.
    if (!(chunkBudgetHit() && queue.length > 0)) await handleBarges();
    // Terry CLOSES once every owner has spoken (queue drained). Direct runBounded call bypasses the
    // spoken-guard (host already opened). If the chunk budget is spent first, ceremonyCloser stays
    // set and survives in progress → the next chunk runs it (queue empty by then, so it's next up).
    if (ceremonyCloser && queue.length === 0 && replies.length < replyCap && !chunkBudgetHit()) {
      const [closerId, closerDir] = ceremonyCloser;
      if (data.members.includes(closerId) && AGENT_BY_ID[closerId]) {
        ceremonyDirectiveById.set(closerId, closerDir);
        spoken.delete(closerId);
        const r = await runBounded(closerId, buildPrior());
        mergeAgentResult(closerId, r, [closerId]);
      }
      ceremonyCloser = null;
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
          if (a)
            recordFallback(
              "tool",
              `${a.name}: deferred — turn deadline reached before it could run.`,
              "deferred (deadline)",
              a.id,
            );
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
    const hasMore =
      replies.length < replyCap &&
      !atChunkCap &&
      (remainingEligible.length > 0 || ceremonyCloser != null);
    if (hasMore) {
      try {
        await turnStore.saveTurnChunk(turnId, replies, buildResumeState(), false);
      } catch (e) {
        console.error("[turn-chunk] partial save failed", e instanceof Error ? e.message : e);
      }
      return { ...finalResult(), partial: true };
    }
    ensureNotSilentOnRealWork();
    try {
      await turnStore.saveTurnChunk(turnId, replies, null, true, finalResult());
    } catch (e) {
      console.error("[turn-chunk] done save failed", e instanceof Error ? e.message : e);
    }
    persistResearchedMemory();
    return { ...finalResult(), partial: false };
  }

  ensureNotSilentOnRealWork();
  persistResearchedMemory();
  return finalResult();
}

export const sendHuddleMessage = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }) => runHuddleTurn(data));

// BARGE-IN: the user interjects during a live ceremony. Instead of a separate, uncoordinated turn,
// we queue the message onto the RUNNING ceremony turn; its driver pops it between speakers, answers
// it, then resumes the round-robin. Idempotent (barge id) + kicks the runner so a between-chunk
// ceremony picks it up immediately. Returns queued=false if the ceremony already finished (the client
// then falls back to a normal message).
const BargeInput = z.object({
  turnId: z.string().min(6).max(80),
  text: z.string().min(1).max(2000),
});
export const bargeCeremony = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => BargeInput.parse(raw))
  .handler(async ({ data }) => {
    const { appendBarge } = await import("./tasks/turns.server");
    const slug = data.text
      .slice(0, 32)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const bargeId = `barge-${data.turnId}-${slug}`;
    const queued = await appendBarge(data.turnId, { id: bargeId, text: data.text });
    if (queued) void kickNextChunk(data.turnId);
    return { ok: true, queued };
  });

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
// ACT-huddle-4: this used to be a single unretried attempt with an empty catch — a failed self-kick
// (network blip, cold-start, transient 5xx) was silently invisible and fell straight through to the
// once-a-minute pg_cron backstop, which is exactly the "notices my barge after a large delay"
// complaint. Retry a few times with short backoff before giving up, and log every failure so a
// stranded barge is at least diagnosable. Missing config is logged distinctly from a transient
// failure since retrying can never fix it.
const KICK_MAX_ATTEMPTS = 3;
const KICK_BACKOFF_MS = [250, 750];
async function kickNextChunk(turnId: string): Promise<void> {
  const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  const rawBase =
    (process.env.HUDDLE_APP_URL ?? "").trim() ||
    (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : "");
  const base = rawBase.replace(/\/$/, "");
  if (!token || !base) {
    const missing = [!token && "JOURNEY_PROXY_TOKEN", !base && "HUDDLE_APP_URL/WEBSITE_HOSTNAME"]
      .filter(Boolean)
      .join(", ");
    console.error(
      `[kickNextChunk] misconfigured (turn ${turnId}): ${missing} unset — self-kick disabled, relying on the cron backstop only (up to 60s)`,
    );
    return;
  }
  for (let attempt = 1; attempt <= KICK_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}/api/public/run-turn`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": token },
        body: JSON.stringify({ turnId }),
      });
      if (res.ok) return;
      console.error(
        `[kickNextChunk] non-2xx response (turn ${turnId}, attempt ${attempt}/${KICK_MAX_ATTEMPTS}): HTTP ${res.status}`,
      );
    } catch (err) {
      console.error(
        `[kickNextChunk] fetch failed (turn ${turnId}, attempt ${attempt}/${KICK_MAX_ATTEMPTS}):`,
        err,
      );
    }
    if (attempt < KICK_MAX_ATTEMPTS)
      await new Promise((r) => setTimeout(r, KICK_BACKOFF_MS[attempt - 1]));
  }
  console.error(
    `[kickNextChunk] all ${KICK_MAX_ATTEMPTS} attempts failed (turn ${turnId}) — deferring to the cron backstop (up to 60s)`,
  );
}

// ---- Pillar 2: worker sub-turn + fan-in integration ---------------------------------------------

type WorkerPayload = {
  role: string;
  objective: string;
  inputs?: string;
  acceptance_criteria?: string;
  personaId?: string;
  personaName?: string;
  orchestrationId?: string;
  originHuddleId?: string;
  originScope?: string;
};
type WorkerResult = {
  role: string;
  ok: boolean;
  findings: string;
  artifactId: string | null;
  artifactName: string | null;
  error: string;
};

/**
 * Run one delegated WORKER sub-turn: a bounded specialist that does its own web-search + create_artifact
 * (NO delegate tool → no nested orchestration, AC-5), then persists its structured findings and fans in
 * to the persona's integration. Never throws out — a worker error is recorded and still counts toward
 * the fan-in so the integration proceeds and notes the gap (AC-4).
 */
async function runWorkerTurn(record: {
  id: string;
  user_email: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { completeTurn } = await import("./tasks/turns.server");
  const payload = record.payload as {
    worker?: WorkerPayload;
    caller?: { entra_object_id?: string; entra_email?: string };
    timeZone?: string;
    router?: unknown;
    agents?: Record<string, { model?: string }>;
  };
  const w = payload.worker;
  const result: WorkerResult = {
    role: w?.role ?? "specialist",
    ok: false,
    findings: "",
    artifactId: null,
    artifactName: null,
    error: "",
  };

  try {
    if (!w?.role || !w.objective) throw new Error("malformed worker payload");
    const worker = getWorker(w.role);
    if (!worker) throw new Error(`unknown worker role: ${w.role}`);

    const caller = payload.caller ?? {};
    const email =
      (await (await import("./journey/identity")).resolveTaskEmail(caller)) ??
      caller.entra_email ??
      null;

    // Executive profile so the worker is executive-grade too (best-effort; "" when unset).
    let execBlock = "";
    try {
      if (email) {
        const { getUserContext, renderExecutiveContext } =
          await import("./identity/user-context.server");
        execBlock = renderExecutiveContext(await getUserContext(email));
      }
    } catch {
      /* profile optional */
    }

    const { workerPrompt } = await import("./agents/workers");
    const instructions = workerPrompt(
      worker,
      {
        objective: w.objective,
        inputs: w.inputs,
        acceptance_criteria: w.acceptance_criteria,
        personaName: w.personaName,
      },
      { operatingContract: OPERATING_CONTRACT, execBlock },
    );

    // Worker tools: web search + create_artifact ONLY. Exactly one artifact per worker.
    let artifactId: string | null = null;
    let artifactName: string | null = null;
    const onToolCall = async (c: {
      name: string;
      arguments: Record<string, unknown>;
    }): Promise<string> => {
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
          return JSON.stringify(r);
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (c.name === "create_artifact") {
        const a = c.arguments;
        const name = String(a.name ?? "").trim();
        const content = String(a.content ?? "");
        if (!name || !content)
          return JSON.stringify({ ok: false, error: "name and content are required" });
        if (artifactId) return JSON.stringify({ ok: true, deduped: true, id: artifactId });
        if (!email) return JSON.stringify({ ok: false, error: "sign-in required" });
        try {
          const { createArtifact } = await import("./artifacts/artifacts.server");
          const { id, deepLink } = await createArtifact({
            userEmail: email,
            agentId: w.personaId ?? null, // attribute to the accountable persona
            taskId: a.task_id ? String(a.task_id) : null,
            folder: String(a.folder ?? worker.role),
            name,
            mime: String(a.mime ?? "text/markdown"),
            bytes: Buffer.from(content, "utf8"),
          });
          artifactId = id;
          artifactName = name;
          let pendingConfirmNote: string | undefined;
          if (a.task_id) {
            const { ensureReviewFlip } = await import("./tasks/tasks.server");
            const flip = await ensureReviewFlip(
              String(a.task_id),
              email,
              payload.caller,
              w.personaId ?? null,
            );
            if (flip.pendingConfirm) {
              pendingConfirmNote =
                "Saved, but held out of the user's review queue — you never confirmed the Definition of Done with them. Send the confirm-intent ask now (what you believe they wanted + the DoD) and call confirm_task_intent once they reply.";
            }
          }
          return JSON.stringify({
            ok: true,
            id,
            deepLink,
            ...(pendingConfirmNote ? { note: pendingConfirmNote } : {}),
          });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return JSON.stringify({ error: `unknown tool: ${c.name}` });
    };

    // Model selection funnels through the SAME resolver as interactive turns — no parallel brain, no
    // stale hardcoded model. Auto-work has the task OBJECTIVE (not a router difficulty score), so use the
    // task-type resolver: classify the objective → tier, capped by the agent's ceiling. Seeded from the
    // per-agent config default (5.6) and falling back to Luna if the persona is unknown. (Previously this
    // was `?? "gpt-4o-mini"` — a divergent path that never migrated to 5.6 and misreported the migration.)
    const workerPersona = (w.personaId ?? "") as AgentId;
    // Auto-work runs server-side without the user's Settings policy object, but it DOES carry per-agent
    // models — so overlay ceilings from those onto the default policy (base = DEFAULT_MODEL_POLICY).
    const workerResolved = AGENT_BY_ID[workerPersona]
      ? resolveModel(w.objective, workerPersona, effectiveModelPolicy(payload.agents, undefined))
      : null;
    const model = workerResolved?.model || payload.agents?.[workerPersona]?.model || "gpt-5.6-luna";
    const { callOpenAIResponses } = await import("./openai-responses.server");
    const res = await callOpenAIResponses({
      model,
      ...(workerResolved?.effort ? { reasoningEffort: workerResolved.effort } : {}),
      instructions,
      transcript: [{ role: "user", content: w.objective }],
      tools: [TAVILY_WEB_SEARCH_TOOL, CREATE_ARTIFACT_TOOL],
      onToolCall,
      maxToolHops: 6,
      promptCacheKey: `worker:${worker.id}`,
    });
    result.ok = true;
    result.findings = res.text;
    result.artifactId = artifactId;
    result.artifactName = artifactName;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  // Terminal: status='done' even on a worker error, so the fan-in sees every row as complete (AC-4).
  try {
    await completeTurn(record.id, { worker: result });
  } catch {
    /* best-effort persist */
  }

  if (w?.orchestrationId) {
    try {
      await maybeEnqueueIntegration(w.orchestrationId, record.user_email, payload);
    } catch {
      /* fan-in is non-fatal */
    }
  }
}

/**
 * Fan-in: when EVERY worker sub-turn of an orchestration is terminal, enqueue exactly ONE integration
 * turn (idempotent id → race-safe) in which the accountable persona critiques + integrates the workers'
 * findings into the single answer the user sees, with their documents attached as chips (AC-3).
 */
async function maybeEnqueueIntegration(
  orchestrationId: string,
  userEmail: string | null,
  workerPayload: {
    worker?: WorkerPayload;
    caller?: unknown;
    timeZone?: string;
    router?: unknown;
    agents?: unknown;
  },
): Promise<void> {
  const { getOrchestrationWorkers, enqueueTurn } = await import("./tasks/turns.server");
  const rows = await getOrchestrationWorkers(orchestrationId);
  if (!rows.length) return;
  if (!rows.every((x) => x.status === "done" || x.status === "error")) return;

  const w = workerPayload.worker;
  const personaId = w?.personaId as AgentId | undefined;
  if (!personaId || !AGENT_BY_ID[personaId]) return; // can't integrate without a valid persona
  const originHuddleId = w?.originHuddleId ?? `dm-${personaId}`;
  const originScope: "group" | "one-to-one" = w?.originScope === "group" ? "group" : "one-to-one";

  // Per-worker findings budget so the assembled directive stays under the Input `text` 4000-char cap.
  const perWorker = Math.max(300, Math.min(900, Math.floor(2600 / Math.max(1, rows.length))));
  const attach: { id: string; name: string }[] = [];
  const lines: string[] = [];
  for (const row of rows) {
    const wr = (row.result as { worker?: WorkerResult } | null)?.worker;
    if (!wr) continue;
    const label = getWorker(wr.role ?? "")?.role ?? wr.role ?? "specialist";
    if (wr.artifactId)
      attach.push({ id: wr.artifactId, name: wr.artifactName ?? `${label} findings` });
    const status = wr.ok ? "" : ` (INCOMPLETE${wr.error ? `: ${wr.error.slice(0, 100)}` : ""})`;
    const doc = wr.artifactId ? ` [document: /artifacts/${wr.artifactId}]` : "";
    const findings = (wr.findings ?? "").trim().slice(0, perWorker) || "(no findings returned)";
    lines.push(`— ${label}${status}:${doc}\n${findings}`);
  }

  const directive = (
    `Your specialists have finished the workstreams you delegated. Here is what each returned` +
    `${attach.length ? " (their full documents are linked)" : ""}:\n\n${lines.join("\n\n")}\n\n` +
    `Now do YOUR job as the accountable lead: critique any weak, unsupported, or conflicting points, ` +
    `then integrate everything into ONE cohesive executive answer for the user — informative, then ` +
    `analytical, then actionable, then strategic. Reference their documents; do NOT concatenate or ` +
    `paste their reports. If a workstream came back incomplete, say so honestly and give your best ` +
    `recommendation anyway.`
  ).slice(0, 3990);

  const integrationId = `integrate-${orchestrationId}`;
  const integrationPayload = {
    text: directive,
    huddleId: originHuddleId,
    scope: originScope,
    members: [personaId],
    targetAgentId: personaId,
    history: [],
    router: workerPayload.router,
    agents: workerPayload.agents,
    timeZone: workerPayload.timeZone,
    caller: workerPayload.caller,
    attachArtifacts: attach.length ? attach : undefined,
    notify: "push",
    internal: true, // the persona is delivering the integrated answer — it must not defer/pass along
  };
  const fresh = await enqueueTurn(integrationId, originHuddleId, userEmail, integrationPayload);
  if (fresh) void kickNextChunk(integrationId);
}

async function executeClaimedTurn(record: {
  id: string;
  user_email: string | null;
  payload: Record<string, unknown>;
  progress?: unknown;
}): Promise<HuddleTurnResult | null> {
  const { failTurn } = await import("./tasks/turns.server");
  try {
    // Pillar 2: a WORKER sub-turn (persona delegated a workstream) runs a bounded specialist instead of
    // the normal multi-agent turn — its own web-search + create_artifact only (no delegate → no nesting),
    // then fans in to the persona's integration. Self-contained (never throws out); returns null so the
    // push/chunk logic below is skipped (workers are internal, notify:"silent").
    if ((record.payload as { worker?: unknown }).worker) {
      await runWorkerTurn(record);
      return null;
    }
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
    // Away-gate — TWO conditions, and the second one is the fix for a real outage.
    //
    // `foreground` is a SEND-TIME snapshot: it says the user had this huddle on screen when they hit
    // send. That was the whole gate, and it was wrong, because a turn here runs 19-24s — plenty of time
    // to hit send and walk away. The reply then landed in-app with no push, so the user came back to a
    // message they were never told about. Agent-initiated turns (blocker surfaces, standups, reach-outs)
    // never set `foreground`, which is exactly why THOSE kept buzzing while replies went silent — the
    // asymmetry the user reported.
    //
    // So `foreground` is now only the first half: it still scopes this suppression to turns the user
    // themself started while watching. The second half asks the question at DELIVERY time — are they
    // still here? — and only then is the push redundant. `isUserPresent` fails open (any doubt → false
    // → push), so the failure mode is a duplicate buzz, never another swallowed reply.
    const foreground = (record.payload as { foreground?: boolean })?.foreground === true;
    let stillHere = false;
    if (foreground && record.user_email) {
      const { isUserPresent } = await import("./tasks/turns.server");
      stillHere = await isUserPresent(record.user_email);
    }
    const wantsPush = notifyLevel !== "batch" && notifyLevel !== "silent" && !(foreground && stillHere);
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
    // ACT-huddle-3: everything below used to run unguarded — an exception anywhere in here (including
    // inside executeClaimedTurn's own catch path, e.g. if failTurn's DB write itself throws) bypassed
    // the chunked/resumable turn mechanism entirely and surfaced to the browser as an opaque 500 with
    // no message. Wrap it so the real error is both logged server-side and returned to the client.
    try {
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
          return {
            turnId,
            status: (partial ? "partial" : "done") as string,
            result,
            error: null as string | null,
          };
        }
        const rec = await getTurn(turnId);
        return {
          turnId,
          status: (rec?.status ?? "error") as string,
          result: null as HuddleTurnResult | null,
          error: rec?.error ?? null,
        };
      }
      const rec = await getTurn(turnId);
      return {
        turnId,
        status: (rec?.status ?? "queued") as string,
        result: null as HuddleTurnResult | null,
        error: rec?.error ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[enqueueHuddleTurn] unhandled error (turn ${turnId}, huddle ${data.huddleId}):`,
        err,
      );
      return {
        turnId,
        status: "error" as string,
        result: null as HuddleTurnResult | null,
        error: message,
      };
    }
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
type TurnUpdateDTO = {
  id: string;
  status: string;
  error: string | null;
  updated_ms: number;
  seq: number;
  // The user's OWN message for this turn (from the persisted payload). The durable store is the
  // recovery source of truth for a turn, but historically only agent `replies` were surfaced — so a
  // reload/reconnect/cross-device load re-materialized the agents' replies while the user's own prompt
  // (which lives only in the debounced workspace blob) went missing, leaving orphaned agent messages.
  // Surfacing it here lets the client re-add the user message from the same durable turn.
  userText: string | null;
  replies: {
    agentId: AgentId;
    text: string;
    artifacts?: { id: string; name: string }[];
    confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
  }[];
  result: HuddleTurnResult | null;
};
export const getTurnUpdates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => TurnUpdatesInput.parse(raw))
  .handler(async ({ data }) => {
    // ACT-huddle-3: this used to run unguarded — an exception from getTurnsSince surfaced to the
    // browser as an opaque 500 with no message, indistinguishable from any other failure. Wrap it.
    try {
      const { getTurnsSince } = await import("./tasks/turns.server");
      const rows = await getTurnsSince(data.huddleId, data.sinceMs ?? 0);
      // Trim to a serializable DTO (drop the raw payload; type result like the live turn result).
      // `replies` + `seq` carry the incrementally-streamed per-agent replies for in-flight
      // ('partial'/'running') turns so the client renders them as they land; `result` is the full
      // payload set once the turn is 'done'. The client keys agent messages on reply index (idempotent),
      // so a partial turn re-appearing with more replies just appends the new ones.
      const turns: TurnUpdateDTO[] = rows.map((t) => ({
        id: t.id,
        status: t.status as string,
        error: t.error,
        updated_ms: t.updated_ms,
        seq: t.seq,
        // ONLY for genuine user turns. submit() ids every user turn `u-<ms>`; every agent-INITIATED
        // turn (autowork/standup/groom/followup) uses a semantic prefix and stores its INTERNAL
        // DIRECTIVE in payload.text — surfacing that would render the directive as a "You" message.
        userText: (/^u-\d+$/.test(t.id) ? ((t.payload as { text?: string } | null)?.text ?? null) : null) as
          | string
          | null,
        replies: (t.replies ?? []) as {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
        }[],
        result: (t.result ?? null) as HuddleTurnResult | null,
      }));
      return { turns };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[getTurnUpdates] unhandled error (huddle ${data.huddleId}):`, err);
      return { turns: [] as TurnUpdateDTO[], error: message };
    }
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
  // Liveness piggyback (see the away-gate in executeClaimedTurn). The client's OWN timestamp of its
  // last real interaction — NOT "now". A backgrounded tab still fires throttled timers, so recording
  // arrival time would read every open-but-abandoned tab as "the user is here" and re-break the very
  // thing this fixes. Carried on the poll that already runs, so presence costs no extra request.
  lastInteractionMs: z.number().optional(),
});
export const getAllTurnUpdates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => AllTurnUpdatesInput.parse(raw))
  .handler(async ({ data }) => {
    type BackfillTurn = {
      id: string;
      huddleId: string;
      updated_ms: number;
      // The user's own message for this turn — see TurnUpdateDTO.userText. Lets the cross-huddle
      // back-fill re-add the user's prompt (not just the agents' replies) when the workspace blob is
      // stale/missing, so an away-arrived turn shows the full exchange, not orphaned agent messages.
      userText: string | null;
      replies: {
        agentId: AgentId;
        text: string;
        artifacts?: { id: string; name: string }[];
        confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
      }[];
      // Tool-use breadcrumbs for away/cross-device turns — the client filters per agent + drops tool_catalog.
      toolUses?: import("../data/seed").ToolUseEvent[];
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
    const { getUserTurnsSince, recordUserPresence } = await import("./tasks/turns.server");
    // Best-effort, non-blocking: a failed presence write only means a redundant push later.
    if (typeof data.lastInteractionMs === "number" && data.lastInteractionMs > 0) {
      void recordUserPresence(email, data.lastInteractionMs);
    }
    const rows = await getUserTurnsSince(email, data.sinceMs ?? 0);
    const turns: BackfillTurn[] = rows.map((t) => ({
      id: t.id,
      huddleId: t.huddle_id,
      updated_ms: t.updated_ms,
      // Only genuine user turns (`u-<ms>`); agent-initiated turns store an internal directive in
      // payload.text — see TurnUpdateDTO.userText. Never surface a directive as a "You" message.
      userText: (/^u-\d+$/.test(t.id) ? ((t.payload as { text?: string } | null)?.text ?? null) : null) as
        | string
        | null,
      // A 'done' turn's authoritative replies live in `result.replies`; fall back to the streamed column.
      replies: ((t.result as { replies?: unknown } | null)?.replies ?? t.replies ?? []) as {
        agentId: AgentId;
        text: string;
        artifacts?: { id: string; name: string }[];
        confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
      }[],
      toolUses: ((t.result as { toolUses?: unknown } | null)?.toolUses ?? undefined) as
        | import("../data/seed").ToolUseEvent[]
        | undefined,
    }));
    return { turns };
  });

/** Save/refresh a Web Push subscription for the signed-in user (for notify-while-away). */
const PushSubInput = z.object({
  caller: z
    .object({
      entra_object_id: z.string().optional(),
      entra_email: z.string().optional(),
    })
    .optional(),
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
