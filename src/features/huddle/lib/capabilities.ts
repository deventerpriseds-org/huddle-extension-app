// Ownership backbone — everything about "who exclusively owns what" is derived HERE
// from `agent.capabilities` in agents.ts, never from a hardcoded name. The roster
// surfaced to every agent, the router's ownership rule, the scope-aware hand-off
// behaviour, and the exclusive-tool gating all read these helpers, so adding a
// capability to any agent (or a new agent that owns one) works across the whole
// roster with zero per-case code. See AgentCapability in agents.ts.
import { AGENTS, type Agent, type AgentCapability, type AgentId } from "../data/agents";

// ─── Turn intent classification ────────────────────────────────────────────────
// Lightweight, trait-driven intent classifier. Determines the SEMANTIC INTENT of
// the user's current message so capability/lane hand-off logic suppresses spurious
// deferrals when the user is NOT asking for a capability to be PERFORMED.
//
// Conservative by design: defaults to "perform" when uncertain, so no genuine
// delegation is ever blocked. Only suppresses when clear positive evidence exists
// that the message is not a performance request. Works for every capability with
// zero per-capability configuration.
export type TurnIntent = "perform" | "status" | "query" | "acknowledge" | "inform";

// Acknowledge: very short reactive messages ("thanks", "ok", "got it", emoji)
const ACKNOWLEDGE_RE: RegExp[] = [
  /^(thanks|thank you|thx|ty|ok|okay|k|got it|got that|great|perfect|sounds good|sure|alright|noted|understood|cool|nice|yep|yup|nope|no problem|no worries|will do|roger|cheers|brilliant|awesome)\b[!.?]*$/i,
  // Multi-word ack ("ok got it", "thanks, that's helpful") — bounded, and requires an ack-adjective
  // ending so it can't swallow a command like "ok mark that done" (no helpful/good/clear tail).
  /^(ok|okay|got it|alright|sure|thanks|thank you|great|perfect|cool|noted)\b.{0,25}\b(helpful|good|great|clear|makes sense|got it|thanks|appreciate)\b[!.?]*$/i,
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u,
];

// Query: message is asking a factual question (ownership, existence, status).
// NOTE: bare /\?$/ is intentionally absent — polite delegation requests
// ("can you groom the backlog?", "could you triage this?") also end with "?"
// but are perform requests, not queries. Only unambiguous question openers qualify.
const QUERY_RE: RegExp[] = [
  /^(who|what)\b/i,
  // "is/are/does/did …?" openers. NOT bare "do" — "do it now" / "do the thing" are IMPERATIVES, not
  // questions (that mis-tagged a command as a query). Keep "do you/we/they/I …?" as a real question.
  /^(is|are|does|did)\s/i,
  /^do\s+(you|we|they|i)\b/i,
  /^how'?(s|re)\b/i, // "how's the burn", "how're we doing" — contraction openers the pattern below misses
  /^can you (tell|explain|clarify)\b/i,
  /\b(who (handles?|owns?|does?|runs?|manages?|takes? care of))\b/i,
  /^(how (does?|do|can|is|are|would|could|will|should|much|many))\b/i,
  /^(any (updates?|news|progress|info|questions?|issues?|blockers?))\b/i,
  // RECALL is a query, not a command. "remind me / tell me / catch me up on WHAT we decided / WHO owns
  // X / OF the name" asks the agent to surface a past fact — it is NOT a schedule-a-reminder request.
  // Classifying it here (the ONE intent system) is what lets the reminder-force respect it, instead of
  // a bespoke lookahead on the reminder regex. A genuine "remind me TO call at 5" has no interrogative
  // and stays "perform".
  /\b(remind|tell|catch|fill|update|brief)\s+me\b.*?\b(wh(?:at|o|en|ere|y|ich|om)|how)\b/i,
  /\bremind me\s+of\b/i,
];

// Status: user is confirming or reporting that something is already done
const STATUS_RE: RegExp[] = [
  // Broad catch-all for "mark <anything up to 100 chars> as done/complete/etc."
  // Covers long NPs ("mark the 'Update on backlog grooming' task... as done") that defeat
  // the narrow \w+-only pattern below. Bounded to prevent catastrophic backtracking.
  /\bmark\b.{0,100}\b(as )?(done|complete|finished|closed|resolved)\b/i,
  /\bmark(ed)?( (that|it|this|the \w+){0,3})? (as )?(done|complete|finished|closed|resolved)\b/i,
  // "make X done" — the user says "make" as often as "mark" (real transcript: "make both the
  // prepare for gym done and the transfer 40k done"). Bounded 0-120 chars to allow two-item asks.
  /\bmake\b.{0,120}\b(done|complete|finished|closed|resolved)\b/i,
  /\b(can you|could you|please)\b.{0,120}\b(done|complete|finished|closed|resolved)\b/i,
  /\bcheck(ed)? (that|it|this|the \w+( \w+){0,3}) off\b/i,
  /\b(that'?s|it'?s|this is|we'?re|i'?m) (done|finished|complete|completed|all done|resolved|sorted)\b/i,
  /^(done|finished|complete|completed|closed|resolved|wrapped( up)?)[!.]*$/i,
  /\b(all done|wrapped( it)? up|sorted (it|that)|took care of it|marked (as )?done)\b/i,
  /\b(just (finished|completed|wrapped up|closed|resolved))\b/i,
  /\b(closed|resolved|finished|completed) (it|that|this)\b/i,
  /\balready (done|finished|complete|completed|closed|resolved)\b/i,
];

// Inform: sharing information without requesting action
const INFORM_RE: RegExp[] = [
  /^(just so you know|fyi|for your info|heads up|letting you know|wanted to let you know)\b/i,
  /^the .{1,50} (is|has been|was) (done|finished|complete|ready|sorted|resolved|set up|updated)[!.]*$/i,
];

// Conversational preambles that carry NO intent. A natural barge often opens with one
// ("quick question — what day is it?", "hey Sam, …", "sorry to interrupt, …"). The ^-anchored
// intent patterns above would otherwise miss the real ask hiding AFTER the filler and fall
// through to the "perform"/"slow" default — which is exactly what mis-QUEUED a live question in
// a stand-up (observed: "quick question — what day is it today?" → deferred instead of answered).
// Stripping the filler before matching fixes it for EVERY intent consumer, not just the barge.
const PREAMBLE_RE =
  /^\s*(?:(?:hey|hi|hello|yo|ok|okay|so|well|um+|uh+|erm|actually|alright)\b|(?:sorry(?:\s+to\s+interrupt)?|excuse me|pardon(?:\s+me)?)|(?:quick question|one quick (?:thing|question)|real quick|quick one|got a (?:quick )?(?:q|question)|just wondering|question)|(?:hey|hi|hello)\s+[a-z]+)\s*[,.!:—–-]*\s*/i;

// Agent first names, derived from the roster (data-driven, never hardcoded) — a leading vocative
// ("Finn, is the transfer done?") defeats the ^-anchors the same way a filler does; the addressee
// is resolved separately (resolveAddressed), so dropping it for CLASSIFICATION only is safe.
const AGENT_FIRST_NAMES = new Set(AGENTS.map((a) => a.name.split(/\s+/)[0].toLowerCase()));
function stripLeadingVocative(t: string): string {
  const m = /^([a-z]+)\s*[,:]\s+(.+)/i.exec(t);
  if (m && AGENT_FIRST_NAMES.has(m[1].toLowerCase()) && m[2].trim()) return m[2].trim();
  return t;
}

// Peel leading fillers + a vocative (a few times: "hey Finn, quick question — is it done?") so the
// real ask reaches the anchored matchers. Falls back to the original if stripping empties it.
function normalizeForIntent(text: string): string {
  let s = text.trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    const deFilled = s.replace(PREAMBLE_RE, "").trim();
    s = stripLeadingVocative(deFilled || s);
    if (s === before || !s.trim()) break;
  }
  return s.trim() || text.trim();
}

/**
 * Classify the semantic intent of a user message. Used to gate capability and lane
 * hand-off logic — those systems must only fire when the user is requesting an action
 * to be PERFORMED, not when they are confirming completion, querying ownership, etc.
 */
export function classifyTurnIntent(text: string): TurnIntent {
  if (!text.trim()) return "acknowledge";
  const t = normalizeForIntent(text);

  for (const re of ACKNOWLEDGE_RE) if (re.test(t)) return "acknowledge";
  for (const re of QUERY_RE) if (re.test(t)) return "query";
  for (const re of STATUS_RE) if (re.test(t)) return "status";
  for (const re of INFORM_RE) if (re.test(t)) return "inform";

  return "perform";
}

// ─── Ceremony ask classification (P0) ───────────────────────────────────────────
// A stand-up barge falls into a TYPE that drives the flow, plus an URGENCY override:
//   quick-verbal → answer inline, live (a question/ack — no mutation, safe to do now)
//   fast-action  → a status flip ("mark/make X done"): ack + move to the Huddle DOING lane +
//                  queue the real completion (status flips took 10-15s live, so they don't block)
//   slow         → tool/research/multi-step work: ack + queue for after the ceremony
// Built ON TOP of classifyTurnIntent (the ONE intent system) — NOT a parallel router. Conservative:
// anything ambiguous falls to "slow" (defer/queue), never "quick-verbal", so a misread never
// executes a task prematurely.
export type AskType = "quick-verbal" | "fast-action" | "slow";
export type AskUrgency = "default" | "now";
export interface AskClass {
  type: AskType;
  urgency: AskUrgency;
  intent: TurnIntent;
}

// Explicit "do it now" signals — the user overriding the default (which is defer/queue).
const URGENCY_RE: RegExp[] = [
  /\b(right now|right away|immediately|this second|this instant|do it now|now please|asap|straight away)\b/i,
  /\bnow\b\s*[!.]*$/i, // trailing "now"
  /^\s*now\b[,\s]/i, // leading "now,"
];

export function classifyAsk(text: string): AskClass {
  const t = (text ?? "").trim();
  const intent = classifyTurnIntent(t);
  const urgency: AskUrgency = URGENCY_RE.some((re) => re.test(t)) ? "now" : "default";
  let type: AskType;
  switch (intent) {
    case "query":
    case "acknowledge":
    case "inform":
      type = "quick-verbal"; // just an answer — safe to voice live, no task work
      break;
    case "status":
      type = "fast-action"; // a status flip
      break;
    default: // "perform" — and any future intent: default to the SAFE, deferred path
      type = "slow";
      break;
  }
  return { type, urgency, intent };
}

// Immediate, TYPE-AWARE, VARIED acknowledgement voiced the instant the user hands an agent a task —
// so they're never met with silence while the real (10-15s) answer is produced. It restates the ACTION
// ("marking that now" / "let me pull that together"), varied per call (same meaning, different words),
// and CRITICALLY never says "done" — the confirmed completion + "done" comes later from the queue/buzz
// (P3), because saying done-before-done is unsafe. Owner-aware phrasing (defer to the owner) is layered
// on server-side where the task→owner is resolved; this client line covers the gap immediately.
export function bargeAckLine(text: string): string {
  const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
  const { type } = classifyAsk(text);
  if (type === "fast-action")
    return pick([
      "On it — marking that now.",
      "Sure, I'll get that updated.",
      "Got it — updating that now.",
      "Okay, I'll take care of that status.",
    ]);
  if (type === "slow")
    return pick([
      "On it — let me pull that together.",
      "Sure, I'll dig into that.",
      "Got it — I'll look into that.",
      "Okay, let me work on that.",
    ]);
  return pick([
    "One moment — let me take a look.",
    "Sure, checking now.",
    "Let me pull that up.",
    "Give me a moment.",
  ]);
}

export interface OwnedCapability {
  agent: Agent;
  cap: AgentCapability;
}

/** True if `agent` owns the capability `capId` (any capability; exclusive or not). */
export function agentOwnsCapability(agent: Agent | undefined, capId: string): boolean {
  return !!agent?.capabilities?.some((c) => c.id === capId);
}

/** The agents that own an EXCLUSIVE capability (restricted to `members` when given). */
export function exclusiveCapabilities(members?: readonly AgentId[]): OwnedCapability[] {
  const inScope = members ? new Set(members) : null;
  const out: OwnedCapability[] = [];
  for (const agent of AGENTS) {
    if (inScope && !inScope.has(agent.id)) continue;
    for (const cap of agent.capabilities ?? []) {
      if (cap.exclusive) out.push({ agent, cap });
    }
  }
  return out;
}

/** The owner agent of an exclusive capability id, if present in `members` (or the whole roster). */
export function ownerOfCapability(
  capId: string,
  members?: readonly AgentId[],
): Agent | undefined {
  return exclusiveCapabilities(members).find((o) => o.cap.id === capId)?.agent;
}

/**
 * Deterministically resolve which exclusive-capability OWNER a message is asking for, by matching the
 * text against each capability's `triggers`. Returns the owning agent + capability, or null. This is the
 * back-channel used for 1:1 hand-off — the runtime knows the owner without an @mention or LLM judgement.
 */
export function capabilityOwnerFor(text: string): OwnedCapability | null {
  const t = text.toLowerCase();
  for (const { agent, cap } of exclusiveCapabilities()) {
    if ((cap.triggers ?? []).some((phrase) => t.includes(phrase.toLowerCase()))) {
      return { agent, cap };
    }
  }
  return null;
}

/** The exclusive-capability markers for a single agent's roster line, e.g. " [owns: backlog grooming …]". */
export function ownershipMarker(agent: Agent): string {
  const owned = (agent.capabilities ?? []).filter((c) => c.exclusive);
  return owned.length ? ` [owns: ${owned.map((c) => c.label).join("; ")}]` : "";
}

/**
 * A compact ownership directory for prompts:
 *   "- backlog grooming, triage & sprint/board assignment → @terry-locke"
 * Restricted to the exclusive owners present in this huddle. Empty string when none.
 */
export function ownershipDirectory(members: readonly AgentId[]): string {
  const owned = exclusiveCapabilities(members);
  if (!owned.length) return "";
  return owned.map((o) => `- ${o.cap.label} → @${o.agent.handle}`).join("\n");
}
