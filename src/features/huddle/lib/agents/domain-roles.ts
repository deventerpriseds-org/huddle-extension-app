// Standing, research-grounded, PORTABLE anchor/worker table (docs/plan-wip-confirm-review-gate.md,
// Part 3). Keyed by DOMAIN, never by a specific persona's name — so a different deployment with an
// entirely different roster of agent personalities can still plug into the same researched real-world
// ladders, by mapping ITS OWN agents' domains/themes (agents.ts) onto these same domain keys (the same
// keyword-matching mechanism routing.ts's scoreAgentAgainst already does for routing).
//
// The PERSONA is the anchor — the senior, accountable, domain-authority role in that department (this
// deployment already gave its personas senior titles: Finn is a "Finance Strategist," not a junior
// analyst). A Pillar-2 shared worker (workers.ts) is a JUNIOR SPECIALIST that reports to/supports the
// anchor, never a third "reviewer" entity sitting above it — that was an earlier, corrected draft of
// this design. Where no dedicated worker exists yet for a domain, delegation (when the anchor's own
// judgment calls for it) routes to the generic "research-analyst" support capability and is narrated
// generically ("the support team came back with...") rather than inventing a specialist that doesn't
// exist. Build a dedicated worker for a domain only once it's actually exercised enough to justify one.

import type { Worker } from "./workers";
import { WORKERS } from "./workers";

export interface DomainRole {
  /** Stable key, e.g. "finance" -- match against an agent's domains/themes to resolve who anchors it. */
  domain: string;
  /** Human-facing label for this domain. */
  label: string;
  /** The real-world senior title an anchor in this domain would hold (generic -- not persona-bound). */
  anchorTitle: string;
  /** The Pillar-2 worker (workers.ts key) that supports this domain's anchor, if one exists yet. */
  workerId?: string;
  /** One-line citation/reasoning for the ladder above. */
  basis: string;
}

export const DOMAIN_ROLES: DomainRole[] = [
  {
    domain: "finance",
    label: "Finance",
    anchorTitle: "Finance Strategist / Senior Financial Analyst",
    workerId: "financial-analyst",
    basis: "Researched ladder: Analyst -> Senior Analyst -> Manager/Director; the anchor sits at the senior end.",
  },
  {
    domain: "ventures",
    label: "Ventures / Startup",
    anchorTitle: "Startup / Venture Planner",
    workerId: "market-research-analyst",
    basis: "The analyst supports the strategist in the real world; the anchor stays accountable for the call.",
  },
  {
    domain: "communications",
    label: "Communications",
    anchorTitle: "Senior Communications Lead",
    workerId: "writer",
    basis: "Researched ladder: Writer -> Senior Comms Manager/Director. The writer drafts; the senior owner signs off.",
  },
  {
    domain: "product",
    label: "Product",
    anchorTitle: "Senior Product Manager / Director",
    basis: "Researched ladder: Associate PM -> PM -> Senior PM -> Director -> VP -> CPO; the anchor is already senior.",
  },
  {
    domain: "risk",
    label: "Risk (cross-cutting)",
    anchorTitle: "Task-owning persona (no separate risk chief)",
    workerId: "risk-analyst",
    basis:
      "Researched ladder: Analyst -> Manager -> Senior Risk Manager -> CRO. Here the \"senior\" slot is whichever " +
      "persona already owns the task (e.g. Finn for financial risk, Sam for venture risk), not a separate chief.",
  },
  {
    domain: "coordination",
    label: "Coordination / admin",
    anchorTitle: "Chief of Staff",
    basis: "Family-office/EA literature: an EA reports to the Chief of Staff; the anchor already reads at that level.",
  },
  {
    domain: "career",
    label: "Career",
    anchorTitle: "Senior Career Coach",
    basis: "Reasoned from the standard coach -> senior-coach ladder; the anchor is already senior.",
  },
  {
    domain: "education",
    label: "Education (EMBA)",
    anchorTitle: "Senior Academic Advisor",
    basis: "Reasoned from the standard academic-advising ladder; the anchor is already senior.",
  },
  {
    domain: "fitness",
    label: "Fitness / Health",
    anchorTitle: "Head Coach",
    basis: "Reasoned from the trainer -> head-coach ladder; the anchor is already senior.",
  },
  {
    domain: "travel",
    label: "Travel",
    anchorTitle: "Senior Travel Consultant",
    basis: "Reasoned from the standard travel-industry ladder; the anchor is already senior.",
  },
  {
    domain: "family",
    label: "Family / household",
    anchorTitle: "Lifestyle Manager",
    basis: "Family-office literature: a lifestyle manager reports to the Chief of Staff/principal.",
  },
  {
    domain: "process",
    label: "Process / ceremonies",
    anchorTitle: "Scrum Master / Orchestrator",
    basis: "An orchestration role (the hardened review gate, Part 2) -- not a worker/reviewer pair.",
  },
];

/** Look up a domain role by its stable key (case-insensitive), or undefined if not in the table. */
export function domainRole(domain: string): DomainRole | undefined {
  const key = domain.trim().toLowerCase();
  return DOMAIN_ROLES.find((d) => d.domain === key);
}

/** The Pillar-2 worker that supports a domain's anchor, if one exists yet. */
export function workerForDomain(domain: string): Worker | undefined {
  const id = domainRole(domain)?.workerId;
  return id ? WORKERS[id] : undefined;
}

/** Generic fallback narration for a domain with no dedicated worker (Part 3's "support team" clause). */
export const GENERIC_SUPPORT_NOTE =
  "When your domain has no dedicated specialist yet, delegate (when it's genuinely worth it) to the " +
  "general research-analyst support capability and narrate it generically -- e.g. \"the support team " +
  "came back with...\" -- rather than inventing a named specialist role that doesn't exist.";
