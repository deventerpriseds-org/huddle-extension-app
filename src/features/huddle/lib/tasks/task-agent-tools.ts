// Agent-facing task tool schema (OpenAI function format). Lightweight — no server imports — so it can be
// statically imported into the turn engine without pulling server-only deps into the client bundle; the
// dispatch is dynamically imported inside the handler (mirrors CREATE_ARTIFACT_TOOL).
//
// flag_blocker: how an agent EARNS the "blocked" verdict. When an agent actually works a task and
// genuinely cannot advance it — it needs a user decision/credential, a real-world action only the user
// can take, or a capability the team doesn't have (e.g. moving money) — it calls this with the SPECIFIC
// reason it hit. That sets the journey task's status to BLOCKED (syncs to the mirror) and records the real
// reason for the standup/surfacing. This replaces grooming guessing "blocked" from a task title.

export const FLAG_BLOCKER_TOOL = {
  type: "function",
  name: "flag_blocker",
  description:
    "Flag a task you're working on as BLOCKED — but ONLY after you've genuinely tried and cannot make " +
    "progress on your own. Use it when advancing the task truly requires the user (a decision, a " +
    "credential/password, a real-world action only they can take) or a capability the team doesn't have " +
    "(e.g. moving money, purchasing). Do NOT flag a task just because the user must ultimately finish it — " +
    "if you can research, analyze, or draft toward it, do that instead. Give the SPECIFIC reason, in plain " +
    "words, so the user knows exactly what you need from them.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task you're blocked on." },
      reason: { type: "string", description: "The specific, concrete reason you can't proceed — what you need from the user." },
    },
    required: ["task_id", "reason"],
  },
} as const;

// confirm_task_intent: locks in the WIP confirm-intent gate's Definition of Done
// (docs/plan-wip-confirm-review-gate.md, Part 1). An assigned agent calls this ONLY after the user has
// actually replied to its confirm-intent ask — confirming as-is, or with their additions/corrections
// folded in. Writes tasks.task_engagement_state (confirm_status='confirmed') AND journey's
// definition_of_done via update_task, so the DoD is durable on the canonical task and visible on the
// board tooltip. This is what unblocks the task's UP_NEXT->DOING promotion.
export const CONFIRM_TASK_INTENT_TOOL = {
  type: "function",
  name: "confirm_task_intent",
  description:
    "Lock in the Definition of Done for a task, AFTER the user has replied to your confirm-intent ask " +
    "(confirming it, adding to it, or correcting it). Do NOT call this before they've actually responded — " +
    "it's what moves the task from 'waiting on you to confirm' into active work. Pass the FINAL definition " +
    "of done text, folding in whatever the user added or corrected.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task whose intent/DoD you're confirming." },
      definition_of_done: {
        type: "string",
        description: "The concrete, testable Definition of Done as confirmed with the user (their corrections/additions folded in).",
      },
    },
    required: ["task_id", "definition_of_done"],
  },
} as const;

// propose_task_intent: records your PROPOSED Definition of Done the moment you send the confirm-intent
// ask — in the SAME turn/message, BEFORE the user has replied. This is distinct from confirm_task_intent
// (which locks in the FINAL, user-confirmed DoD afterward): propose_task_intent only stores what you
// proposed, deterministically and structurally, so the user's client can offer a "Confirm" button that
// acts on your exact proposed text without needing to re-parse a free-text reply. Does NOT confirm
// anything and does NOT unblock the task — confirm_task_intent still does that, only after the user
// actually responds.
export const PROPOSE_TASK_INTENT_TOOL = {
  type: "function",
  name: "propose_task_intent",
  description:
    "Call this in the SAME message/turn you send your confirm-intent ask to the user — right after " +
    "stating what you believe they want and proposing a Definition of Done, BEFORE they've replied. " +
    "This just records your proposed DoD so the user can act on it with one tap; it does not confirm " +
    "or lock in anything (confirm_task_intent does that, later, after they respond).",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task you're proposing intent for." },
      task_title: { type: "string", description: "The task's title, exactly as given to you." },
      definition_of_done: {
        type: "string",
        description: "The concrete, testable Definition of Done you just proposed to the user in this same message.",
      },
    },
    required: ["task_id", "task_title", "definition_of_done"],
  },
} as const;

// propose_approach: the pre-work half of the hardened workflow gate (approach-gate.server.ts). Called
// ONCE, immediately after confirm_task_intent, in the same reply — the assigned agent drafts HOW it
// plans to reach the confirmed Definition of Done, and a sub-agent grades it pass/revise before any
// real research/work starts. This never involves the user directly; it's purely between the agent and
// the reviewing sub-agent, bounded by a configurable cap. Only on cap exhaustion does the tool result
// tell the agent to raise it with the user itself.
export const PROPOSE_APPROACH_TOOL = {
  type: "function",
  name: "propose_approach",
  description:
    "Call this ONCE, immediately after confirm_task_intent succeeds — before doing any actual work. " +
    "Describe HOW you plan to reach the confirmed Definition of Done: method, sources, structure, " +
    "level of depth. A reviewer grades it for soundness and value; you'll get back either approval " +
    "(proceed with the work) or specific feedback to revise and call this again with an improved " +
    "approach. Do not start researching or drafting the actual deliverable until this returns approved.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task this approach is for." },
      approach: {
        type: "string",
        description: "Concrete plan for how you'll get to the Definition of Done — method, sources, structure, scope.",
      },
    },
    required: ["task_id", "approach"],
  },
} as const;

// ask_clarifying_question / resolve_clarifying_question: a bounded, rate-limited channel for an agent
// to get more detail from the user MID-WORK, without spamming — one open question per task at a time,
// capped lifetime total (identity/agent-workflow-config.server.ts). This is for a genuine unknown that
// blocks good work, not routine narration; flag_blocker remains the right call for a true dead-end.
export const ASK_CLARIFYING_QUESTION_TOOL = {
  type: "function",
  name: "ask_clarifying_question",
  description:
    "Ask the user ONE clarifying question mid-work, when you've hit a genuine unknown that would " +
    "meaningfully change your approach or waste effort if you guessed wrong — not for routine checks. " +
    "This is rate-limited: you can only have one open question per task at a time, and a small lifetime " +
    "cap per task. Your reply text IS the question sent to the user; this tool just records it. Once " +
    "they answer (a normal message in this chat) and you've incorporated it, call " +
    "resolve_clarifying_question so your normal work cadence resumes. If you're truly stuck rather than " +
    "just wanting more detail, use flag_blocker instead.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task you need clarification on." },
      question: { type: "string", description: "The specific question — this should match what you're asking the user in your reply." },
    },
    required: ["task_id", "question"],
  },
} as const;

export const RESOLVE_CLARIFYING_QUESTION_TOOL = {
  type: "function",
  name: "resolve_clarifying_question",
  description:
    "Call this once the user has answered your open clarifying question and you've incorporated their " +
    "answer, so the task's normal work cadence resumes.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task whose open question is now resolved." },
    },
    required: ["task_id"],
  },
} as const;
