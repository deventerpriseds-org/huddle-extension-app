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
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u,
];

// Query: message is asking a factual question (ownership, existence, status).
// NOTE: bare /\?$/ is intentionally absent — polite delegation requests
// ("can you groom the backlog?", "could you triage this?") also end with "?"
// but are perform requests, not queries. Only unambiguous question openers qualify.
const QUERY_RE: RegExp[] = [
  /^(who|what)\b/i,
  /^(is|are|does|do|did)\s/i,
  /^can you (tell|explain|clarify)\b/i,
  /\b(who (handles?|owns?|does?|runs?|manages?|takes? care of))\b/i,
  /^(how (does?|do|can|is|are|would|could|will|should|much|many))\b/i,
  /^(any (updates?|news|progress|info|questions?|issues?|blockers?))\b/i,
];

// Status: user is confirming or reporting that something is already done
const STATUS_RE: RegExp[] = [
  // Broad catch-all for "mark <anything up to 100 chars> as done/complete/etc."
  // Covers long NPs ("mark the 'Update on backlog grooming' task... as done") that defeat
  // the narrow \w+-only pattern below. Bounded to prevent catastrophic backtracking.
  /\bmark\b.{0,100}\b(as )?(done|complete|finished|closed|resolved)\b/i,
  /\bmark(ed)?( (that|it|this|the \w+){0,3})? (as )?(done|complete|finished|closed|resolved)\b/i,
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

/**
 * Classify the semantic intent of a user message. Used to gate capability and lane
 * hand-off logic — those systems must only fire when the user is requesting an action
 * to be PERFORMED, not when they are confirming completion, querying ownership, etc.
 */
export function classifyTurnIntent(text: string): TurnIntent {
  const t = text.trim();
  if (!t) return "acknowledge";

  for (const re of ACKNOWLEDGE_RE) if (re.test(t)) return "acknowledge";
  for (const re of QUERY_RE) if (re.test(t)) return "query";
  for (const re of STATUS_RE) if (re.test(t)) return "status";
  for (const re of INFORM_RE) if (re.test(t)) return "inform";

  return "perform";
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
