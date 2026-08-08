// PROTOTYPE — task-type → model/effort policy (NOT yet wired into the turn path or Settings).
//
// Single source of "how hard is this ask, and what brain does it deserve". Mirrors lib/capabilities.ts
// (one module owns a cross-cutting decision, read everywhere). The POLICY is DATA (DEFAULT_MODEL_POLICY),
// meant to move into the Settings-editable backends config so the user can retune per experience —
// nothing here is a hardcoded literal the user can't change.
//
// Two-layer classification, matching the existing router pattern:
//   • deterministic keyword layer (this file) = fast path + fallback,
//   • the LLM router (routeMessageLLM) will emit a `taskType`/`complexity` = the smart path (passed in
//     via opts.llmTaskType to override the heuristic when present).
// A manual override (opts.manual) always wins — the "change the model/thinking myself" fallback.

import type { AgentId } from "../data/agents";

export type Effort = "low" | "medium" | "high" | "max";
export interface TierChoice {
  model: string; // e.g. "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol"
  effort: Effort;
}

// Escalation ladder — try cheap THINKING before a bigger MODEL (reasoning tokens bill at the model's
// cheap output rate, so luna-high << terra). Ordered cheapest→most capable.
export const LADDER: { label: string; model: string; effort: Effort }[] = [
  { label: "luna-low", model: "gpt-5.6-luna", effort: "low" },
  { label: "luna-high", model: "gpt-5.6-luna", effort: "high" },
  { label: "terra-med", model: "gpt-5.6-terra", effort: "medium" },
  { label: "terra-high", model: "gpt-5.6-terra", effort: "high" },
  { label: "sol-high", model: "gpt-5.6-sol", effort: "high" },
  { label: "sol-max", model: "gpt-5.6-sol", effort: "max" },
];
export function ladderIndex(model: string, effort: Effort): number {
  const i = LADDER.findIndex((l) => l.model === model && l.effort === effort);
  return i < 0 ? 0 : i;
}

export type TaskType =
  | "ack" // acknowledgement / social
  | "read" // quick fact / status read
  | "crud" // single tool op (add task, set reminder, reschedule)
  | "recall" // memory lookup
  | "short_draft" // one-liner / quick reply
  | "plan" // multi-step plan / sequence / itinerary
  | "decide" // judgment / prioritize / tradeoff
  | "analyze" // numeric / analytical
  | "produce" // quality deliverable (essay, resume, email, brief)
  | "deep_strategy" // complex multi-constraint strategy / modeling
  | "research"; // long research → written brief

export interface ModelPolicy {
  /** General map: task type → the brain it deserves. EDITABLE in Settings. */
  general: Record<TaskType, TierChoice>;
  /** Per-agent ceiling — the MOST capable rung an agent may reach (caps auto-escalation cost). */
  ceiling?: Partial<Record<AgentId, "luna" | "terra" | "sol">>;
  /** Per-agent per-task overrides (rare; e.g. Cam's `produce` → sol for public messaging). */
  override?: Partial<Record<AgentId, Partial<Record<TaskType, TierChoice>>>>;
}

// Seeded from the reviewed task-type table. This is the object that will back the Settings editor.
export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  general: {
    ack: { model: "gpt-5.6-luna", effort: "low" },
    read: { model: "gpt-5.6-luna", effort: "low" },
    crud: { model: "gpt-5.6-luna", effort: "low" },
    recall: { model: "gpt-5.6-luna", effort: "low" },
    short_draft: { model: "gpt-5.6-luna", effort: "low" },
    plan: { model: "gpt-5.6-terra", effort: "medium" },
    decide: { model: "gpt-5.6-terra", effort: "high" },
    analyze: { model: "gpt-5.6-terra", effort: "high" },
    produce: { model: "gpt-5.6-terra", effort: "high" },
    deep_strategy: { model: "gpt-5.6-sol", effort: "high" },
    research: { model: "gpt-5.6-terra", effort: "high" },
  },
  // Agents whose hardest work justifies Sol; everyone else caps at Terra (see the reviewed table).
  ceiling: {
    "iris-chase": "sol",
    "terry-locke": "sol",
    "finn-reid": "sol",
    "sam-trent": "sol",
    "tess-sutton": "sol",
    "liam-kingsley": "sol",
    "cam-post": "terra",
    "cole-blake": "terra",
    "elle-rowan": "sol", // make-or-break admissions essay
    "troy-lennox": "sol", // complex international itinerary
    "faith-hartley": "terra",
    "flex-grimes": "terra",
    "charleston-lewis": "terra",
    "ezra-miles": "luna",
    "eli-vaughn": "terra",
  },
  override: {
    // Sam's substantive asks default deep — strategy is his whole job.
    "sam-trent": { plan: { model: "gpt-5.6-terra", effort: "high" }, decide: { model: "gpt-5.6-sol", effort: "high" } },
  },
};

// --- deterministic keyword classifier (fast path / fallback) ---
const RX: { type: TaskType; re: RegExp }[] = [
  { type: "ack", re: /^(thanks|thank you|ok|okay|got it|great|perfect|cool|nice|sounds good|👍)\b/i },
  { type: "deep_strategy", re: /\b(gtm|go[- ]to[- ]market|business model|fundrais|pitch (deck|narrative)|market entry|multi[- ]entity|holding company|acquisition|comprehensive strategy|end[- ]to[- ]end plan|financial model|three[- ]statement|scenario model)\b/i },
  { type: "research", re: /\b(research|deep dive|investigate|competitive (analysis|landscape)|market (research|analysis)|write .* (brief|report|memo)|survey the)\b/i },
  { type: "produce", re: /\b(draft|write|compose|rewrite|polish|resume|cover letter|essay|email|announcement|social post|one[- ]pager|brief|proposal|packet)\b/i },
  { type: "analyze", re: /\b(analyz|budget|refinanc|runway|cash ?flow|compare|cost|forecast|reconcile|calculate|estimate the (cost|budget)|break ?down the numbers)\b/i },
  { type: "decide", re: /\b(prioriti|groom|triage|decide|should i|which (should|one)|trade[- ]?off|what matters|what.s next|recommend|pros and cons|sprint plan)\b/i },
  { type: "plan", re: /\b(plan|schedule out|sequence|itinerary|roadmap|organize my|map out|lay out|week of|multi[- ]?(city|stop|day))\b/i },
  { type: "crud", re: /\b(add|create|set (a )?(reminder|alarm)|remind me|mark .* (done|complete)|reschedule|move .* to|park|assign|update|edit|delete|cancel|book)\b/i },
  { type: "recall", re: /\b(what did we|what was|remind me what|do you remember|earlier you|last time|who owns|what.s the status)\b/i },
  { type: "read", re: /\b(what.s on my|show me|list|when is|do i have|what.s today|any .* today|next meeting|on my (calendar|schedule))\b/i },
];

export function classifyTaskType(text: string): TaskType {
  const t = (text || "").trim();
  for (const { type, re } of RX) if (re.test(t)) return type;
  // very short, no verb → treat as a quick read/ack; otherwise a short reply.
  return t.length <= 40 ? "read" : "short_draft";
}

const CEIL_RANK: Record<string, number> = { luna: 1, terra: 2, sol: 3 };
function modelRank(model: string): number {
  if (model.includes("sol")) return 3;
  if (model.includes("terra")) return 2;
  return 1;
}
function capToCeiling(choice: TierChoice, ceiling?: "luna" | "terra" | "sol"): TierChoice {
  if (!ceiling) return choice;
  if (modelRank(choice.model) <= CEIL_RANK[ceiling]) return choice;
  const capped = ceiling === "luna" ? "gpt-5.6-luna" : ceiling === "terra" ? "gpt-5.6-terra" : "gpt-5.6-sol";
  // When we cap the MODEL down, bump EFFORT up one notch (cheap-think compensation).
  const effort: Effort = choice.effort === "low" ? "high" : choice.effort;
  return { model: capped, effort };
}

export interface ResolveOpts {
  /** taskType from the LLM router (smart path) — overrides the heuristic when present. */
  llmTaskType?: TaskType;
  /** manual user override (ladder label, e.g. "sol-max") — always wins. */
  manual?: string;
}
export interface ResolvedModel {
  model: string;
  effort: Effort;
  taskType: TaskType;
  source: "manual" | "llm" | "heuristic";
  reason: string;
}

export function resolveModel(
  text: string,
  agentId: AgentId,
  policy: ModelPolicy = DEFAULT_MODEL_POLICY,
  opts: ResolveOpts = {},
): ResolvedModel {
  if (opts.manual) {
    const rung = LADDER.find((l) => l.label === opts.manual);
    if (rung) return { model: rung.model, effort: rung.effort, taskType: "produce", source: "manual", reason: `manual override → ${rung.label}` };
  }
  const taskType = opts.llmTaskType ?? classifyTaskType(text);
  const base = policy.override?.[agentId]?.[taskType] ?? policy.general[taskType];
  const capped = capToCeiling(base, policy.ceiling?.[agentId]);
  return {
    model: capped.model,
    effort: capped.effort,
    taskType,
    source: opts.llmTaskType ? "llm" : "heuristic",
    reason: `${taskType} → ${capped.model}/${capped.effort}${capped.model !== base.model ? " (capped to ceiling)" : ""}`,
  };
}
