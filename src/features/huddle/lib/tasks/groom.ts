// The scrum master's backlog-grooming tool (`groom_backlog`). Jira-style triage over the user's
// real journey backlog: one LLM pass assigns each open task to the best-fit agent, tags it, sets a
// priority, and — respecting the user's editable capability prompt — marks it do / schedule / blocked
// (e.g. a payment task can only be *scheduled* until a Plaid integration exists). It then writes the
// assignment + priority back to journey (canonical) via the huddle-proxy, so the change flows through
// the normal sync into Huddle's mirror. Gated to Terry (scrum master) at the call site.

import { AGENTS, type AgentId } from "../../data/agents";

export const GROOM_BACKLOG_TOOL = {
  type: "function",
  name: "groom_backlog",
  description:
    "Groom the backlog like a scrum master: assign each open task to the best-fit agent, tag it, set its priority, and order what to do next — respecting what the team can actually do right now (some work can only be scheduled, not executed). Writes the assignments/priority back to the real task board. Call this when the user asks to groom/triage/organize/assign the backlog or plan the sprint.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        description: "Optional: only groom tasks in this lane (LIFE, VENTURES, CAREER, EDUCATION, PERSONAL). Omit to groom everything.",
      },
      limit: { type: "number", description: "Max tasks to groom this pass (default 40)." },
    },
    required: [],
  },
  strict: false,
} as const;

export const GROOM_SYSTEM_HINT =
  "When the user asks to groom, triage, organize, assign, or plan the backlog/sprint (a scrum-master job), call `groom_backlog`. It assigns each task to an agent, tags/prioritizes it, respects the team's real capabilities (some tasks can only be scheduled), and reorders the board. Report back what was assigned and what's blocked-on-capability — do not invent an ordering yourself.";

type Caller = { entra_object_id?: string; entra_email?: string };

interface Assignment {
  id: string;
  assigned_agent: string;
  tags: string[];
  action: "do" | "schedule" | "blocked";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  rank: number | null;
  reason: string;
}

const AGENT_IDS = new Set(AGENTS.map((a) => a.id));

// Grooming runs inside a chat turn, so it MUST return promptly — a hung tool produces no agent
// reply at all (the model never gets a result). Bound every network call and the whole write phase.
const WRITE_DEADLINE_MS = 18000; // hard cap on the single batch write so the turn never hangs

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

function rosterForPrompt(): string {
  return AGENTS.map((a) => `- ${a.id} (${a.name}, ${a.role}): ${a.domains.slice(0, 6).join(", ")}`).join("\n");
}

/**
 * Run the grooming router and write results back to journey. Returns a JSON string the model reads.
 * `caller` carries the signed-in identity used to scope tasks and authorize the journey write.
 */
export async function dispatchGroomBacklog(
  caller: Caller | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (!caller?.entra_email) {
    return JSON.stringify({ error: "no_caller_identity", message: "Grooming needs the signed-in user's email." });
  }
  // Resolve the sign-in email (possibly an alias) to the canonical journey email the mirror uses.
  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return JSON.stringify({ error: "not_configured", message: "OPENAI_API_KEY is not set." });

  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;
  // Keep each pass small so classification + the batched write finish comfortably within the tool
  // budget (a large pass is what made grooming time out). The user can ask again to groom more.
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 25) : 15;

  try {
    const _tRead0 = Date.now();
    const { getTasksForUser, getCapabilityPrompt } = await import("./tasks.server");
    const [tasks, capabilityPrompt] = await Promise.all([
      getTasksForUser(email, category),
      getCapabilityPrompt(email),
    ]);
    const _readMs = Date.now() - _tRead0;
    if (!tasks.length) {
      return JSON.stringify({ groomed: 0, message: "No open tasks to groom." });
    }
    const slice = tasks.slice(0, limit);

    // One classification pass over the whole slice.
    const taskLines = slice
      .map((t) => `{"id":"${t.id}","title":${JSON.stringify(t.title)},"category":${JSON.stringify(t.category ?? "")},"due_date":${JSON.stringify(t.due_date ?? "")}}`)
      .join("\n");

    const system = `You are Terry Locke, the scrum master, grooming a backlog like in Jira. Assign each task to exactly ONE agent (the best fit by their domains/role), give it 0-3 short lowercase tags, set a priority (LOW|MEDIUM|HIGH|URGENT), and set an integer rank (1 = do first) ONLY for tasks that are do-able now; use null rank for scheduled/blocked tasks.

Respect the team's real capabilities below. If a task needs a capability the team does NOT have, set action to "schedule" (prep/schedule only) or "blocked", NEVER "do", and add a tag like "needs-capability".

CAPABILITIES:
${capabilityPrompt}

AGENTS (id — name, role: domains):
${rosterForPrompt()}

Return STRICT JSON: {"assignments":[{"id","assigned_agent","tags":[],"action":"do|schedule|blocked","priority","rank":<int|null>,"reason":"<=12 words"}]}. assigned_agent MUST be one of the agent ids above. Include every task id exactly once.`;

    const _tClf0 = Date.now();
    const res = await withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROOM_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Tasks:\n${taskLines}` },
        ],
      }),
      }),
      15000,
      "grooming classification",
    );
    if (!res.ok) {
      return JSON.stringify({ error: "groom_llm_failed", message: `${res.status}: ${(await res.text()).slice(0, 160)}` });
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const _classifyMs = Date.now() - _tClf0;
    const raw = j.choices?.[0]?.message?.content ?? "{}";
    let parsed: { assignments?: Assignment[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify({ error: "groom_bad_json", message: raw.slice(0, 200) });
    }
    const assignments = (parsed.assignments ?? []).filter((a) => a && a.id && AGENT_IDS.has(a.assigned_agent as AgentId));

    // Rank the do-able tasks (1 = do first) so we can set the priority lane.
    const doable = assignments
      .filter((a) => a.action === "do" && typeof a.rank === "number")
      .sort((x, y) => (x.rank as number) - (y.rank as number));
    const rankById = new Map<string, number>();
    doable.forEach((a, i) => rankById.set(a.id, i + 1));

    const blocked: { title: string; reason: string }[] = [];
    for (const a of assignments) {
      if (a.action !== "do") blocked.push({ title: slice.find((t) => t.id === a.id)?.title ?? a.id, reason: a.reason });
    }

    // Compute everything Huddle-side, then push ALL updates to journey in ONE batch call
    // (not N per-task round-trips). Bounded by a timeout so the turn never hangs.
    const updates = assignments.map((a) => {
      const tags = Array.from(
        new Set([
          ...(Array.isArray(a.tags) ? a.tags.map((t) => String(t).toLowerCase()) : []),
          ...(a.action === "schedule" ? ["schedule-only"] : []),
          ...(a.action === "blocked" ? ["blocked-on-capability"] : []),
        ]),
      ).slice(0, 5);
      const rank = rankById.get(a.id);
      return { task_id: a.id, assigned_agent: a.assigned_agent, tags, priority: a.priority, ...(rank ? { rank } : {}) };
    });

    let written = 0;
    const _tW0 = Date.now();
    try {
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await withTimeout(
        invokeJourneyTool({
          toolName: "batch_update_tasks",
          args: { updates },
          caller: caller ?? {},
          context: { source: "huddle" },
        }),
        WRITE_DEADLINE_MS,
        "batch_update_tasks",
      );
      if (r.ok) {
        try {
          const p = JSON.parse(r.output || "{}") as { updated?: number };
          written = typeof p.updated === "number" ? p.updated : updates.length;
        } catch {
          written = updates.length;
        }
      }
    } catch {
      /* batch call failed/timed out — report the plan anyway so Terry can respond */
    }
    const _writeMs = Date.now() - _tW0;

    return JSON.stringify({
      groomed: written,
      total: assignments.length,
      _timings: { readMs: _readMs, classifyMs: _classifyMs, writeMs: _writeMs, tasks: slice.length },
      note:
        written === 0
          ? "Planned the assignments, but the write to the task board didn't confirm — try again in a moment."
          : written < assignments.length
            ? `Wrote ${written} of ${assignments.length}; board reflects changes within a few seconds (async sync).`
            : "Assignments + priority written back to the task board; the Huddle board reflects them within a few seconds (async sync).",
      order: doable.map((a, i) => {
        const t = slice.find((s) => s.id === a.id);
        const agent = AGENTS.find((ag) => ag.id === a.assigned_agent);
        return { rank: i + 1, title: t?.title, assignee: agent?.name, priority: a.priority, why: a.reason };
      }),
      blocked_on_capability: blocked,
    });
  } catch (err) {
    return JSON.stringify({ error: "groom_failed", message: err instanceof Error ? err.message : String(err) });
  }
}
