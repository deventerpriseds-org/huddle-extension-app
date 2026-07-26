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
  "When the user asks you DIRECTLY to groom, triage, organize, assign, or plan the backlog/sprint (a scrum-master job), call `groom_backlog`. It assigns each task to an agent, tags/prioritizes it, respects the team's real capabilities (some tasks can only be scheduled), and reorders the board. Report back what was assigned and what's blocked-on-capability — do not invent an ordering yourself.";

// GROUP hand-off: if a teammate @mentions you to groom, the user already asked in the room —
// so just do it and report, no permission dance (the user's rule: in a group the owner acts).
export const GROOM_HANDOFF_DO_HINT =
  " If a teammate handed this to you in the group (they @mentioned you to groom), the user already asked in the room — go ahead and call `groom_backlog` now, then briefly report what you assigned/reprioritized and why. Do not ask permission again.";

// 1:1 hand-off: you are alone with the user and a teammate flagged that they want grooming; you
// can't see the originating request, so confirm before acting (the user's rule: 1:1 = defer + confirm).
export const GROOM_HANDOFF_CONFIRM_HINT =
  " If you were NOT asked directly — a teammate flagged that the user wants the backlog groomed — do NOT groom yet: greet the user, say who flagged it and what they wanted (e.g. \"Tess let me know you wanted the backlog groomed\"), and ask if they'd like you to do it now. Only call `groom_backlog` once the user gives the go-ahead.";

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
  opts?: { maxLimit?: number },
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
  // Per-pass size. The IN-CHAT tool keeps a small cap (25) so classification + the batched write finish
  // within the live-turn timeout (a large pass is what made grooming time out). The SCHEDULED/backend
  // path passes a higher `opts.maxLimit` (e.g. 80) and an explicit `limit` = its whole open backlog, so a
  // cadence groom covers EVERY open task, not just the top 15 — classification runs in concurrent 5-task
  // chunks, so wall time barely grows. Default (no explicit limit) stays 15 for the in-chat tool.
  const cap = Math.max(1, opts?.maxLimit ?? 25);
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, cap) : Math.min(15, cap);

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

    const system = `You are Terry Locke, the scrum master, grooming a backlog like in Jira. Assign each task to exactly ONE agent (the best fit by their domains/role), give it 0-3 short lowercase tags, set a priority (LOW|MEDIUM|HIGH|URGENT), and set an integer rank (1 = do first) ONLY for tasks that are do-able now; use null rank for scheduled/blocked tasks.

Set each task's action by judging PROGRESS, not COMPLETION. Agents can move almost any knowledge task forward on their own — research it, analyze options, draft a document/plan/recommendation (saved as an artifact) — and THAT counts as "do", even if the user must still review, approve, or take a final real-world step. Criteria:
- "do": an agent can make meaningful progress NOW (research / analysis / draft / produce a document). This is the DEFAULT for knowledge work. Give it a rank.
- "schedule": progress is time-gated — nothing useful can happen until a specific date or event. rank null.
- "blocked": NO useful agent progress is possible until either (a) a capability the team genuinely lacks (spending money, purchasing, sending external messages without approval — see CAPABILITIES), or (b) a specific USER action / decision / credential that must come first and that no amount of research or drafting can substitute for. rank null. ONLY then tag "blocked-on-capability".
Do NOT mark a task "blocked" merely because the user must ultimately finish it, or because the team can't fully COMPLETE it — if an agent can research or draft toward it, it is "do".

CAPABILITIES:
${capabilityPrompt}

AGENTS (id — name, role: domains):
${rosterForPrompt()}

Return STRICT JSON: {"assignments":[{"id","assigned_agent","tags":[],"action":"do|schedule|blocked","priority","rank":<int|null>,"reason":"<=8 words"}]}. assigned_agent MUST be one of the agent ids above. Include every task id exactly once.`;

    // Classification is output-token bound (one JSON object per task), so a single call over the whole
    // slice serializes ~1k tokens and takes ~13s. Split into small chunks classified CONCURRENTLY so
    // wall time collapses to roughly one chunk's latency.
    const CHUNK = 5;
    const chunks: (typeof slice)[] = [];
    for (let i = 0; i < slice.length; i += CHUNK) chunks.push(slice.slice(i, i + CHUNK));
    const _tClf0 = Date.now();
    const classifyChunk = async (chunkTasks: typeof slice): Promise<Assignment[]> => {
      const taskLines = chunkTasks
        .map((t) => `{"id":"${t.id}","title":${JSON.stringify(t.title)},"category":${JSON.stringify(t.category ?? "")},"due_date":${JSON.stringify(t.due_date ?? "")}}`)
        .join("\n");
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
      if (!res.ok) return [];
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      try {
        return (JSON.parse(j.choices?.[0]?.message?.content ?? "{}").assignments ?? []) as Assignment[];
      } catch {
        return [];
      }
    };
    const chunkResults = await Promise.all(chunks.map(classifyChunk));
    const _classifyMs = Date.now() - _tClf0;
    const assignments = chunkResults.flat().filter((a) => a && a.id && AGENT_IDS.has(a.assigned_agent as AgentId));
    if (!assignments.length) {
      return JSON.stringify({ error: "groom_no_assignments", message: "Classification returned nothing — try again." });
    }

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
