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
    "Put the FULL, detailed write-up in `content` as markdown (headings, findings, sources, and a clear " +
    "recommendation) — not a summary; the document is the durable record. Link it to the task you were " +
    "working on with `task_id` when you have one. Your chat reply should still give the user a substantive " +
    "summary of what you found, but the complete detail belongs in the artifact.",
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
