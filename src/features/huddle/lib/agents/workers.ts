// Shared functional WORKERS — the "matrixed org" move. A persona agent (an accountable leader in
// agents.ts) stays the face to the user, but can hand a workstream to a shared SPECIALIST worker via
// the `delegate_to_specialist` tool. Workers are DATA, not code: each is { id, role, charter }. Adding
// a worker is adding a row here (the systematic-capability principle — no per-worker code anywhere).
//
// Workers are NOT personas: they are NOT in AGENT_BY_ID, nothing ROUTES to them, they never speak to
// the user directly, and they get ONLY web-search + create_artifact (no delegate tool → no nested
// orchestration). A worker runs as a durable sub-turn (payload.worker) off the turn deadline; when it
// finishes it produces a reviewable artifact and returns structured findings the persona integrates.
//
// This module is intentionally dependency-free (pure strings) so it can be imported statically into
// the turn engine and the client bundle alike — exactly like artifact-tool.ts.

export interface Worker {
  /** Stable role key used as the delegate `role` argument, e.g. "research-analyst". */
  id: string;
  /** Human-facing role label. */
  role: string;
  /** The specialist operating prompt — role identity + ReAct loop + evidence policy + the
   *  structured output the persona expects back. Layered ON TOP of the shared OPERATING_CONTRACT. */
  charter: string;
}

// The structured shape every worker returns, so a persona can critique + integrate deterministically.
const STRUCTURED_OUTPUT =
  "Structure your written findings (both the artifact body and the summary you return) as: " +
  "(1) Conclusion — your bottom line in 1–2 sentences; (2) Findings — each with the specific evidence/" +
  "source behind it and your confidence; (3) Analysis — what it means and why; (4) Recommendation — the " +
  "concrete next step(s), prioritized, with owner/timing/risk; (5) Risks & assumptions — separate " +
  "verified facts from assumptions; (6) Acceptance check — state plainly whether you met the acceptance " +
  "criteria you were given, and flag any gap. If you could not fully complete the objective, say so " +
  "explicitly in the conclusion rather than padding.";

// The ReAct working loop every worker follows.
const REACT_LOOP =
  "Work in a Reason→Act→Observe loop: think about what you need, use your web-search tool to gather " +
  "current, credible information (plan your queries, prefer authoritative and leading sources, search " +
  "more than once when it helps), read what comes back, then decide the next step. When you have enough " +
  "to be genuinely useful, stop searching and write up the result.";

// The one hard duty shared by every worker: actually SAVE the work.
const SAVE_DUTY =
  "You MUST call create_artifact exactly once to save your full, detailed write-up as a markdown " +
  "document (the durable record the user reviews) — give it the full executive structure. Then return a " +
  "substantive summary of your findings and recommendation as your final message (not just \"see the " +
  "doc\"). Do not claim you did anything you did not actually do with a tool this turn.";

function charter(roleIdentity: string): string {
  return `${roleIdentity}\n\n${REACT_LOOP} ${STRUCTURED_OUTPUT} ${SAVE_DUTY}`;
}

export const WORKERS: Record<string, Worker> = {
  "research-analyst": {
    id: "research-analyst",
    role: "Research Analyst",
    charter: charter(
      "You are a General Research Analyst on the user's team. Your job is to investigate an open " +
        "question thoroughly and impartially and turn it into a decision-ready brief: what is true, what " +
        "the best evidence says, where sources disagree, and what it means for the user.",
    ),
  },
  "market-research-analyst": {
    id: "market-research-analyst",
    role: "Market Research Analyst",
    charter: charter(
      "You are a Market Research Analyst. You size and characterize markets, audiences, competitors, " +
        "trends, and demand: TAM/SAM signals, who the buyers are, what alternatives exist, pricing norms, " +
        "and where the whitespace is. Ground every claim in a real source and note recency.",
    ),
  },
  "financial-analyst": {
    id: "financial-analyst",
    role: "Financial Analyst",
    charter: charter(
      "You are a Financial Analyst. You model the numbers behind a decision: revenue and cost drivers, " +
        "unit economics, pricing, margins, payback and break-even, and the assumptions each rests on. Show " +
        "the arithmetic and the sensitivities; separate a modeled estimate from a sourced fact.",
    ),
  },
  writer: {
    id: "writer",
    role: "Writer / Content Strategist",
    charter: charter(
      "You are a Writer and content strategist. You turn a brief and its inputs into polished, " +
        "on-brand prose — thought-leadership pieces, outlines, positioning, announcements, newsletters — in " +
        "the user's voice and aimed at their audience. Make it publishable, not a rough draft.",
    ),
  },
  "risk-analyst": {
    id: "risk-analyst",
    role: "Risk Analyst",
    charter: charter(
      "You are a Risk Analyst. You stress-test a plan or decision: what could go wrong, how likely and " +
        "how damaging, what the leading indicators are, and how to mitigate or hedge each risk. Be specific " +
        "and prioritized — a ranked risk register, not a vague list of worries.",
    ),
  },
  "assignment-reviewer": {
    id: "assignment-reviewer",
    role: "Assignment Reviewer",
    charter: charter(
      "You are an independent Assignment Reviewer (quality control). You did NOT produce the work you " +
        "are reviewing; your job is to grade a deliverable against its acceptance criteria and the team's " +
        "executive-output standard — is it grounded in evidence, does it reason through all four levels " +
        "(informative/analytical/actionable/strategic), is the recommendation traceable and decision-ready. " +
        "Call out specific deficiencies and give a clear pass/revise verdict. Do not rubber-stamp.",
    ),
  },
};

/** The list of valid role keys, for the tool enum + descriptions. */
export const WORKER_ROLES = Object.keys(WORKERS);

/** Resolve a role argument (case/space/underscore tolerant) to a worker, or undefined. */
export function getWorker(role: string | undefined | null): Worker | undefined {
  if (!role) return undefined;
  const key = String(role).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (WORKERS[key]) return WORKERS[key];
  // tolerate the human label ("Financial Analyst") or a partial ("financial")
  return (
    Object.values(WORKERS).find((w) => w.role.toLowerCase() === key.replace(/-/g, " ")) ??
    Object.values(WORKERS).find((w) => w.id.startsWith(key) || key.startsWith(w.id.split("-")[0]))
  );
}

/** A concise directory of the workers a persona can call, for the roster/instructions. */
export function workerDirectory(): string {
  return Object.values(WORKERS)
    .map((w) => `- ${w.id} — ${w.role}`)
    .join("\n");
}

export interface DelegationPacket {
  objective: string;
  inputs?: string;
  acceptance_criteria?: string;
  /** The persona who delegated, for the worker's framing (it works on their behalf). */
  personaName?: string;
}

/** Build the full worker instructions for a run: charter + the operating contract + the exec profile
 *  (so workers are executive-grade too) + this specific assignment packet. */
export function workerPrompt(
  worker: Worker,
  packet: DelegationPacket,
  opts?: { operatingContract?: string; execBlock?: string },
): string {
  const parts: string[] = [worker.charter];
  if (opts?.operatingContract) parts.push(opts.operatingContract);
  if (opts?.execBlock) parts.push(opts.execBlock);
  const assignment: string[] = [
    `\n\nYour assignment${packet.personaName ? ` (delegated by ${packet.personaName})` : ""}:`,
    `Objective: ${packet.objective}`,
  ];
  if (packet.inputs?.trim()) assignment.push(`Inputs/context: ${packet.inputs.trim()}`);
  if (packet.acceptance_criteria?.trim())
    assignment.push(`Acceptance criteria (you will be judged against these): ${packet.acceptance_criteria.trim()}`);
  assignment.push(
    "Do the work now, save the artifact, and report back. You are working behind the scenes for the " +
      "team lead — you are not speaking to the user directly.",
  );
  parts.push(assignment.join("\n"));
  return parts.join("");
}

// The persona-facing tool. Registered on personas in BOTH dispatch paths (like create_artifact); a
// worker run never gets it (AC-5: no nested orchestration). Mirrors the OpenAI Responses tool shape.
export const DELEGATE_TO_SPECIALIST_TOOL = {
  type: "function",
  name: "delegate_to_specialist",
  description:
    "Hand a workstream to a shared specialist teammate who will research it and produce a reviewable " +
    "document, then report back to you. Use this when a request genuinely needs specialist depth, several " +
    "parallel workstreams, or separation of duties (e.g. an independent review) — NOT for something you can " +
    "answer well yourself right now. You remain accountable: the specialists work behind the scenes, and " +
    "YOU integrate their findings into the single answer the user sees. Delegating is asynchronous — the " +
    "specialists take seconds to minutes. After you delegate, tell the user briefly that you've put the " +
    "team on it and you'll bring it together shortly; do not fabricate the specialists' results. You may " +
    "call this more than once in a turn to run parallel workstreams.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: {
        type: "string",
        enum: WORKER_ROLES,
        description: "Which specialist to task. One of: " + WORKER_ROLES.join(", ") + ".",
      },
      objective: {
        type: "string",
        description: "The specific outcome you need from this specialist — a clear, self-contained brief.",
      },
      inputs: {
        type: "string",
        description: "Any context, constraints, or facts the specialist should start from (optional).",
      },
      acceptance_criteria: {
        type: "string",
        description: "What 'done and good' looks like — the bar the specialist's work must clear (optional).",
      },
    },
    required: ["role", "objective"],
  },
} as const;
