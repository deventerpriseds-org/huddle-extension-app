// The OpenAI-format tool schema for an agent to save its OWN finished work as a reviewable artifact.
// Kept in a lightweight module (no pg/blob imports) so it can be statically imported into the turn
// engine without pulling server-only deps into the client bundle — the dispatch (createArtifact) is
// dynamically imported inside the handler. Mirrors how TAVILY_WEB_SEARCH_TOOL is defined.

export const CREATE_ARTIFACT_TOOL = {
  type: "function",
  name: "create_artifact",
  description:
    "Save your finished work — research findings, a written document, a roadmap, an analysis — as a " +
    "reviewable artifact the user can open and approve. Call this AFTER you've actually done the work. " +
    "Put the FULL, detailed write-up in `content` as markdown — not a summary; the document is the durable " +
    "record. Give it the executive-grade STRUCTURE: (1) an Executive conclusion up top, (2) Key findings, " +
    "each with the evidence/source behind it and your confidence, (3) Analysis — why it matters, causes, " +
    "implications, (4) Recommendations — prioritized, each with owner, timing, and risk, split into immediate " +
    "vs near-term vs strategic and flagging anything that needs the user's approval, (5) Risks & assumptions, " +
    "and (6) Sources. Separate verified facts from assumptions. Link it to the task with `task_id` when you " +
    "have one. Your chat reply should still give a substantive summary, but the complete structured detail " +
    "belongs in the artifact.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short file name with extension, e.g. 'market-research.md'." },
      content: { type: "string", description: "The FULL document in markdown — detailed, well-organized, with sources and a recommendation." },
      folder: { type: "string", description: "Lane/category folder, e.g. 'Ventures', 'Finance', 'Research'." },
      task_id: { type: "string", description: "The id of the task this artifact is for, if applicable." },
      mime: { type: "string", description: "Content type; defaults to text/markdown." },
    },
    required: ["name", "content"],
  },
} as const;

export interface CreateArtifactToolArgs {
  name?: unknown;
  content?: unknown;
  folder?: unknown;
  task_id?: unknown;
  mime?: unknown;
}

// B-OPS-2 -- "show me what my agents produced this week".
//
// WHY IT LIVES HERE. `listArtifactsFn` (artifacts.functions.ts) is a createServerFn for the UI, and
// STATUS-scenarios.md's B-OPS-2 cell is exactly right that nothing in mergedTools lists artifacts:
// an agent could WRITE one (create_artifact, above) and then had no way to read back what it or its
// teammates had produced. This module is already the schema half of that pair and is deliberately
// free of pg/blob imports so the turn engine can import it statically -- so the read schema belongs
// beside the write schema, not in a new module.
//
// THE OWNER'S IDENTITY IS NOT A PARAMETER. `listArtifacts(userEmail, ...)` scopes every row by
// email, so an email/user argument here would be a cross-user read of another person's documents.
// The dispatch resolves it from the signed-in caller exactly as the create_artifact dispatch does
// (resolveTaskEmail(caller) ?? caller.entra_email) and there is no way for the model to reach it --
// the same rule, for the same reason, as the Nexus owner id in nexus.server.ts.
export const LIST_ARTIFACTS_TOOL = {
  type: "function",
  name: "list_artifacts",
  description:
    "The documents the user's agents have already produced and saved — research briefs, analyses, " +
    "roadmaps, plans. Use for 'show me what my agents produced this week', 'what has Terry written', " +
    "'is that market research done yet', 'what's waiting for my review'. Narrow with `days` for a time " +
    "window, `status` for what still needs the user's approval, `agent_id` for one teammate's output, or " +
    "`task_id` for one task's deliverables. This LISTS them with their status — it does not return the " +
    "document text; point the user at the artifact to open it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: {
        type: "number",
        description: "Only artifacts touched within this many days ('this week' = 7). Omit for all.",
      },
      status: {
        type: "string",
        enum: ["review", "approved", "changes", "draft"],
        description:
          "'review' = finished and waiting on the user, 'changes' = sent back for revision, " +
          "'approved' = signed off, 'draft' = still being worked. Omit for all.",
      },
      folder: { type: "string", description: "Lane/category folder, e.g. 'Ventures', 'Finance', 'Research'." },
      agent_id: { type: "string", description: "One agent's output only, by agent id." },
      task_id: { type: "string", description: "Only artifacts saved against this task id." },
      limit: { type: "number", description: "Max artifacts to return. Defaults to 50." },
    },
    required: [],
  },
} as const;

export interface ListArtifactsToolArgs {
  days?: unknown;
  status?: unknown;
  folder?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
  limit?: unknown;
}
