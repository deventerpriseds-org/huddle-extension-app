// The reusable, agent-callable prioritization tool. Any agent can call `prioritize`
// with a dynamic category; it scores the user's mirrored journey tasks (Azure PG) with the
// ported journey engine and returns a ranked list. Shared like the router — Iris (day),
// Liam (life), Tess (product), Sam (venture) all use the same tool with a different category.
// Modeled on rag/tools.ts (schema + dispatch + system hint).

export const PRIORITIZE_TOOL = {
  type: "function",
  name: "prioritize",
  description:
    "Rank the user's open tasks by what to do next, using their real task data (priority, due dates, staleness, keywords). Call this when the user asks what to focus on / prioritize / do next, optionally within a category (life, ventures, career, education, product, finance, etc.). Returns a scored, ordered list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        description:
          "Optional domain to prioritize within, e.g. LIFE, VENTURES, CAREER, EDUCATION, PERSONAL, PROF_EDUCATION. Omit to rank across everything.",
      },
      limit: { type: "number", description: "Max items to return (default 10)." },
    },
    required: [],
  },
  strict: false,
} as const;

export const PRIORITIZE_SYSTEM_HINT =
  "When the user asks what to prioritize, focus on, or do next (optionally within an area like ventures, career, life, product), call the `prioritize` tool with the relevant `category` and answer from its ranked results — do not guess an ordering yourself.";

/**
 * Execute a `prioritize` tool call. Returns a JSON string (the model reads it verbatim).
 * `userEmail` is the caller's identity (data.caller.entra_email); without it we cannot scope
 * to the user's tasks.
 */
export async function dispatchPrioritize(
  userEmail: string | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (!userEmail) {
    return JSON.stringify({
      error: "no_caller_identity",
      message: "Prioritization needs the signed-in user's email; none was provided this turn.",
    });
  }
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 25) : 10;

  try {
    const { getTasksForUser } = await import("./tasks.server");
    const { rankTasks } = await import("./scoring");
    const tasks = await getTasksForUser(userEmail, category);
    const ranked = rankTasks(tasks, limit);
    return JSON.stringify({
      category: category ?? "all",
      count: ranked.length,
      ranked: ranked.map((r, i) => ({
        rank: i + 1,
        title: r.title,
        category: r.category,
        due_date: r.due_date,
        score: r.score,
        why: r.why,
      })),
    });
  } catch (err) {
    return JSON.stringify({
      error: "prioritize_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
