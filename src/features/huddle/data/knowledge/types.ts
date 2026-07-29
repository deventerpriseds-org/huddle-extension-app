// Knowledge library — the "specialized brain" layer.
//
// Each agent gets a KnowledgePack: a git-versioned body of grounded, defensible,
// senior-professional expertise in its discipline — the canonical frameworks it
// reasons from, the precise vocabulary it uses, the benchmarks/standards it can
// defend, how it makes decisions, the concrete activities it runs, and the
// anti-patterns it catches. This is layered ON TOP of the persona/snapshot
// (which is voice + lane), so it is purely additive (see CLAUDE.md additive-only
// rule) — it makes an agent smarter without changing who answers what (routing
// is unchanged; it reads agents.ts, not this).
//
// A pack is DATA. It is rendered to a compact instruction block by
// `renderKnowledgePack` and injected into BOTH instruction branches at runtime
// (see lib/knowledge.ts + huddle.functions.ts), the same way memory is. Adding a
// pack for a new agent needs zero runtime code: register it in ./index.ts.
//
// The same structured content is intended to double as source for per-agent
// OpenAI vector-store files later (file_search) — author once, use both ways.

import type { AgentId } from "../agents";

export interface KnowledgePack {
  agentId: AgentId;
  /** One-line name of the professional discipline, e.g. "Personal & venture finance strategy". */
  discipline: string;
  /**
   * Named, canonical frameworks / standards / bodies-of-knowledge this agent
   * reasons FROM. Prefer things a senior professional would actually cite
   * (e.g. "WSJF", "Scrum Guide 2020", "the Rule of 40"), each with a short gloss
   * of what it is and when it applies.
   */
  frameworks: string[];
  /**
   * Terms of art the agent must use precisely — the vocabulary that signals
   * fluency. Each entry is `term — crisp, correct definition`.
   */
  vocabulary: string[];
  /**
   * Defensible standards, benchmarks, and rules of thumb WITH THE NUMBER/RULE
   * attached, so the agent is quantitative and grounded rather than vague.
   * Each should be something the agent could defend to a professional peer.
   */
  benchmarks: string[];
  /** How a senior practitioner in this lane actually reasons toward a decision. */
  decisionPatterns: string[];
  /** Concrete, repeatable activities/playbooks the agent runs (the "what it does"). */
  playbooks: string[];
  /** Red flags / anti-patterns a seasoned pro spots and calls out. */
  antiPatterns: string[];
}

function section(title: string, items: string[]): string {
  if (!items.length) return "";
  return `\n${title}\n` + items.map((i) => `- ${i}`).join("\n");
}

/**
 * Render a pack into the compact instruction block appended to the agent's
 * prompt. Framed as expertise the agent embodies — NOT a checklist to recite —
 * so replies stay in-voice and concise (house-style still caps length) while
 * being grounded in real standards.
 */
export function renderKnowledgePack(pack: KnowledgePack): string {
  const header =
    `\n\nKNOWLEDGE BASE — ${pack.discipline}. This is your professional expertise: reason from these ` +
    `standards, use the vocabulary precisely, anchor advice to the benchmarks, and catch the red flags. ` +
    `It is grounding, not a script — never dump it, recite it, or name-drop frameworks gratuitously; ` +
    `apply the ONE that fits and stay in your normal voice and length.`;
  return (
    header +
    section("Frameworks & standards you reason from:", pack.frameworks) +
    section("Terms of art (use precisely):", pack.vocabulary) +
    section("Defensible benchmarks & rules of thumb:", pack.benchmarks) +
    section("How you decide:", pack.decisionPatterns) +
    section("Playbooks you run:", pack.playbooks) +
    section("Red flags you catch:", pack.antiPatterns)
  );
}
