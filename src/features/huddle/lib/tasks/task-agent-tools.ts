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
