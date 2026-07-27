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
