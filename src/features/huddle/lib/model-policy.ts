// Task-type/difficulty → model/effort policy. WIRED into the turn path (huddle.functions.ts resolves
// every interactive turn AND the auto-worker through resolveByDifficulty/resolveModel) and into config
// (agent-backends `modelPolicy`, seeded from DEFAULT_MODEL_POLICY, threaded via the turn payload).
//
// Single source of "how hard is this ask, and what brain does it deserve". Mirrors lib/capabilities.ts
// (one module owns a cross-cutting decision, read everywhere). The POLICY is DATA (DEFAULT_MODEL_POLICY
// is only the SEED for the config) — the per-agent ceiling is set from the Settings Model dropdown via
// withAgentCeilings, so nothing here is a hardcoded literal the user can't change.
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
  // o3 sits at the TOP rung (Sol level): it beat Sol-high on deep asks at ~1/6.6 the cost
  // (docs/model-ab-findings.md), so a sol-ceiling agent may use it while terra/luna ceilings cap it DOWN
  // to their 5.6 tier. Exact match so "o3-mini" (a cheaper, weaker model) never inherits the top rank.
  if (model === "o3" || model.includes("sol")) return 3;
  if (model.includes("terra")) return 2;
  return 1;
}

/** The 5.6 tier a model id belongs to, or undefined for a non-5.6 model (which imposes no ceiling). */
export function tierOf(model: string | undefined | null): "luna" | "terra" | "sol" | undefined {
  if (!model || !/gpt-5\.6-(luna|terra|sol)/.test(model)) return undefined;
  return model.includes("sol") ? "sol" : model.includes("terra") ? "terra" : "luna";
}

/**
 * Overlay per-agent ceilings derived from each agent's Settings-chosen model onto a policy — so the
 * per-agent Model dropdown IS the agent's ceiling (the resolver never exceeds the tier the user picked;
 * difficulty only moves it DOWN from there). This makes the one visible per-agent control the single
 * source of an agent's cap — no separate hidden ceiling. A non-5.6 pick imposes no derived ceiling, so
 * the policy's own ceiling still applies. Returns a new policy; never mutates the input.
 */
export function withAgentCeilings(
  policy: ModelPolicy,
  agentModels: Partial<Record<AgentId, string | undefined>>,
): ModelPolicy {
  const ceiling = { ...(policy.ceiling ?? {}) } as Partial<Record<AgentId, "luna" | "terra" | "sol">>;
  for (const [aid, model] of Object.entries(agentModels)) {
    const t = tierOf(model);
    if (t) ceiling[aid as AgentId] = t;
  }
  return { ...policy, ceiling };
}
function capToCeiling(choice: TierChoice, ceiling?: "luna" | "terra" | "sol"): TierChoice {
  if (!ceiling) return choice;
  if (modelRank(choice.model) <= CEIL_RANK[ceiling]) return choice;
  const capped = ceiling === "luna" ? "gpt-5.6-luna" : ceiling === "terra" ? "gpt-5.6-terra" : "gpt-5.6-sol";
  // When we cap the MODEL down, bump EFFORT up one notch (cheap-think compensation).
  const effort: Effort = choice.effort === "low" ? "high" : choice.effort;
  return { model: capped, effort };
}

// ---- Difficulty-driven resolution (the wired path) ----
// Difficulty 1-4 → rung. Deep (3-4) routes to o3-high: per docs/model-ab-findings.md (2026-08-10) it beat
// Sol-high on deep asks (80.5 vs 63.0) at ~1/6.6 the cost, so it needs NO spend gate — needsConfirm keys on
// Sol, which o3 isn't, so the confirm-gate is naturally dormant. Capped to the agent's ceiling (o3 ranks at
// Sol level, so terra/luna ceilings drop it to their 5.6 tier). A manual "sol" override still reaches Sol-high.
export interface DifficultyResolved {
  model: string;
  effort: Effort;
  needsConfirm: boolean; // true when this would auto-spend on the top (Sol) rung
  budgetModel: string; // the cheaper alternative offered at the confirm
  reason: string;
}
const DIFF_RUNG: Record<number, { model: string; effort: Effort; deep?: boolean }> = {
  1: { model: "gpt-5.6-luna", effort: "low" },
  2: { model: "gpt-5.6-luna", effort: "high" },
  3: { model: "o3", effort: "high", deep: true },
  4: { model: "o3", effort: "high", deep: true },
};
const CEIL_MODEL: Record<string, string> = { luna: "gpt-5.6-luna", terra: "gpt-5.6-terra", sol: "gpt-5.6-sol" };

/**
 * Resolve difficulty → {model, effort} for an agent, honoring the per-agent ceiling. Deep asks default
 * to Sol-high with needsConfirm=true (runtime gates the spend, offering Terra-high budget). A manual
 * choice ("sol" | "budget" | ladder label) wins and clears the gate.
 */
export function resolveByDifficulty(
  difficulty: number,
  agentId: AgentId,
  policy: ModelPolicy = DEFAULT_MODEL_POLICY,
  opts: { manual?: string } = {},
): DifficultyResolved {
  const budgetModel = "gpt-5.6-terra";
  // Manual override always wins, no gate.
  if (opts.manual) {
    if (opts.manual === "budget") return { model: budgetModel, effort: "high", needsConfirm: false, budgetModel, reason: "manual: budget (Terra-high)" };
    if (opts.manual === "sol") return { model: "gpt-5.6-sol", effort: "high", needsConfirm: false, budgetModel, reason: "manual: Sol-high" };
    const rung = LADDER.find((l) => l.label === opts.manual);
    if (rung) return { model: rung.model, effort: rung.effort, needsConfirm: false, budgetModel, reason: `manual: ${rung.label}` };
  }
  const d = Math.min(4, Math.max(1, Math.round(difficulty || 2)));
  const base = DIFF_RUNG[d];
  const ceiling = policy.ceiling?.[agentId]; // "luna" | "terra" | "sol"
  // Cap the model to the agent's ceiling. If the deep default (Sol) is capped away, no confirm needed.
  const ceilRank = ceiling ? CEIL_RANK[ceiling] : 3;
  let model = base.model;
  let effort = base.effort;
  let deep = !!base.deep;
  if (modelRank(model) > ceilRank) {
    model = CEIL_MODEL[ceiling!];
    if (effort === "low") effort = "high"; // cheap-think compensation when capped down
    deep = false; // capped below Sol → nothing to confirm
  }
  const needsConfirm = deep && model === "gpt-5.6-sol";
  return { model, effort, needsConfirm, budgetModel, reason: `difficulty ${d} → ${model}/${effort}${needsConfirm ? " (confirm)" : ""}` };
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
