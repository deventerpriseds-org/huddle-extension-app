// The scrum master's backlog-grooming tool (`groom_backlog`). Jira-style triage over the user's
// real journey backlog: one LLM pass assigns each open task to the best-fit agent, tags it, sets a
// priority, and ranks it. It does NOT decide "blocked" — the owning agent earns that by working the task.
// (e.g. a payment task can only be *scheduled* until a Plaid integration exists). It then writes the
// assignment + priority back to journey (canonical) via the huddle-proxy, so the change flows through
// the normal sync into Huddle's mirror. Gated to Terry (scrum master) at the call site.

import { AGENTS, type AgentId } from "../../data/agents";
import { REMINDER_TAG } from "./workability";

export const GROOM_BACKLOG_TOOL = {
  type: "function",
  name: "groom_backlog",
  description:
    "Groom the backlog like a scrum master: assign each open task to the best-fit agent (by their lane/role), tag it, set its priority, and order what to do next. Writes the assignments/priority back to the real task board. Call this when the user asks to groom/triage/organize/assign the backlog or plan the sprint. (Whether a task is blocked is NOT decided here — the owning agent determines that by actually working it.)",
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
  "When the user asks you DIRECTLY to groom, triage, organize, assign, or plan the backlog/sprint (a scrum-master job), call `groom_backlog`. It assigns each task to the best-fit agent, tags/prioritizes it, and reorders the board. Report back what you assigned and reprioritized — do not invent an ordering yourself.";

// GROUP hand-off: if a teammate @mentions you to groom, the user already asked in the room —
// so just do it and report, no permission dance (the user's rule: in a group the owner acts).
export const GROOM_HANDOFF_DO_HINT =
  " If a teammate handed this to you in the group (they @mentioned you to groom), the user already asked in the room — go ahead and call `groom_backlog` now, then briefly report what you assigned/reprioritized and why. Do not ask permission again.";

// 1:1 hand-off (ONLY when a teammate actually passed it to you via the owner-follow-up path): you can't
// see the originating request, so confirm before acting (the user's rule: 1:1 = defer + confirm).
export const GROOM_HANDOFF_CONFIRM_HINT =
  " A teammate flagged that the user wants the backlog groomed and passed it to you — you can't see the original request. Do NOT groom yet: greet the user, say who flagged it and what they wanted, and ask if they'd like you to do it now. Only call `groom_backlog` once the user gives the go-ahead.";

// 1:1 DIRECT ask (the user is talking to YOU in your own DM): just do it. This is the common case and
// must NOT be treated as a hand-off — do not claim a teammate flagged it, do not ask permission.
export const GROOM_HANDOFF_DIRECT_HINT =
  " The user asked YOU directly here, in your own 1:1 — this is your job, so just call `groom_backlog` now and report what you assigned/reprioritized. Do NOT say a teammate flagged it and do NOT ask permission first.";

type Caller = { entra_object_id?: string; entra_email?: string };

interface Assignment {
  id: string;
  assigned_agent: string;
  tags: string[];
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  rank: number | null;
  reason: string;
}

const AGENT_IDS = new Set(AGENTS.map((a) => a.id));

// Grooming runs inside a chat turn, so it MUST return promptly — a hung tool produces no agent
// reply at all (the model never gets a result). Bound every network call and the whole write phase.
const WRITE_DEADLINE_MS = 18000; // hard cap on the single batch write so the turn never hangs
const MIRROR_SYNC_WAIT_MS = 2500; // let journey's async mirror sync land the fresh ranks before auto-work reads them
const AUTOWORK_DEADLINE_MS = 15000; // hard cap on the chained auto-work pass so grooming never hangs on it

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
    const { getTasksForUser } = await import("./tasks.server");
    // PARKING LOT (ACT-13/ACT-17): a task tagged `parking-lot` opts OUT of all automation. Grooming must
    // NOT re-classify it — beyond churning a task the user deliberately set aside, the tags writeback
    // below REPLACES the whole tags array, which would silently STRIP `parking-lot` and un-park the task,
    // letting journey's nightly builder re-schedule it. Filter parked tasks out here so grooming never
    // touches them (mirrors autowork.server.ts candidate filtering).
    // REMINDER WINDOW: a `reminder`-tagged task whose reminder is scheduled and hasn't fired yet is
    // skipped for the same reason a parked task is — the user has already decided what happens next and
    // when. Re-grooming it would churn a decision they just made, and could re-propose a reminder for
    // something already waiting on one. It becomes eligible again the moment the reminder fires.
    const { taskIdsInReminderWindow } = await import("./turns.server");
    const inWindow = await taskIdsInReminderWindow(email);
    const tasks = (await getTasksForUser(email, category)).filter(
      (t) => !(t.tags ?? []).includes("parking-lot") && !inWindow.has(t.id),
    );
    const _readMs = Date.now() - _tRead0;
    if (!tasks.length) {
      return JSON.stringify({ groomed: 0, message: "No open tasks to groom." });
    }
    const slice = tasks.slice(0, limit);

    const system = `You are Terry Locke, the scrum master, grooming a backlog like in Jira. For each task: assign it to exactly ONE agent (the best fit by their domains/role), give it 0-3 short lowercase descriptive tags, set a priority (LOW|MEDIUM|HIGH|URGENT), and set an integer rank (1 = do first) reflecting the order to tackle things. You are ORGANIZING the backlog — assigning, tagging, prioritizing, ordering. You do NOT decide whether a task is "blocked" or un-doable; the assigned agent determines that by actually working it. Just route every task to its best owner and rank it.

REMINDER TAG — the one judgement that is yours. Add the tag "${REMINDER_TAG}" when NO agent could finish
anything real on this task using only what the team already has (the user's profile, memory, board,
email/calendar, and their own tools). These are the user's own errands, purchases, payments, physical
trips, and anything needing access or facts only they hold: "Order replacement tire" (nobody knows their
car or tire size), "Go to church", "Transfer funds", "Investigate <third-party> issues" (the records are
not reachable). Still assign an owner — that agent owns the FOLLOW-UP, not the doing.
Do NOT tag genuine knowledge-work the team can complete alone: research, drafting, planning, analysis,
specs, outlines, summaries. When in doubt, ADD the tag: a wrong "${REMINDER_TAG}" costs the user one
correcting message, while a wrong omission makes an agent promise work it cannot do.
If a task ALREADY carries "${REMINDER_TAG}" in its current tags, keep it unless it is now plainly
agent-doable work.

ASSIGNMENT STABILITY — if a task already has an assignee and that agent is still a reasonable fit, KEEP
them. Do not reshuffle owners between passes for a marginal improvement: re-assigning resets the task's
confirmation state and re-triggers a fresh check-in message to the user, so churn here becomes noise for
them.

AGENTS (id — name, role: domains):
${rosterForPrompt()}

Return STRICT JSON: {"assignments":[{"id","assigned_agent","tags":[],"priority","rank":<int>,"reason":"<=8 words"}]}. assigned_agent MUST be one of the agent ids above. Include every task id exactly once.`;

    // Classification is output-token bound (one JSON object per task), so a single call over the whole
    // slice serializes ~1k tokens and takes ~13s. Split into small chunks classified CONCURRENTLY so
    // wall time collapses to roughly one chunk's latency.
    const CHUNK = 5;
    const chunks: (typeof slice)[] = [];
    for (let i = 0; i < slice.length; i += CHUNK) chunks.push(slice.slice(i, i + CHUNK));
    const _tClf0 = Date.now();
    const classifyChunk = async (chunkTasks: typeof slice): Promise<Assignment[]> => {
      // `current_tags` and `current_agent` are sent because two rules above depend on the model SEEING
      // today's state: keep an existing `reminder` tag, and keep an existing assignee rather than
      // reshuffling (which resets confirmation state and re-pings the user). Without these fields both
      // instructions are unenforceable — the model would be guessing at state it was never shown.
      const taskLines = chunkTasks
        .map(
          (t) =>
            `{"id":"${t.id}","title":${JSON.stringify(t.title)},"category":${JSON.stringify(t.category ?? "")},` +
            `"due_date":${JSON.stringify(t.due_date ?? "")},` +
            `"current_tags":${JSON.stringify((t.tags ?? []).map((x) => String(x).toLowerCase()))},` +
            `"current_agent":${JSON.stringify(t.assigned_agent ?? "")}}`,
        )
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

    // Normalize ranks to a dense 1..N ordering (1 = do first) for the priority lane.
    const ranked = assignments
      .filter((a) => typeof a.rank === "number")
      .sort((x, y) => (x.rank as number) - (y.rank as number));
    const rankById = new Map<string, number>();
    ranked.forEach((a, i) => rankById.set(a.id, i + 1));

    // Compute everything Huddle-side, then push ALL updates to journey in ONE batch call
    // (not N per-task round-trips). Bounded by a timeout so the turn never hangs. Grooming only
    // assigns/tags/prioritizes — it never sets a blocked status (the owning agent does that by working it).
    // Grooming REPLACES a task's tags with the model's fresh descriptive tags. Preserve user CONTROL
    // tags the model doesn't know about (ACT-17 parity: an automation pass must never clobber a user's
    // deliberate control state). `parking-lot` is already filtered out above; keeping it here too — plus
    // `blocked` — makes the writeback safe even if a parked task ever reaches this point.
    // `reminder` is a control tag too: grooming itself sets it (a task no agent can do alone), and it
    // must survive the next pass or the mode silently reverts and the agent goes back to inventing a
    // deliverable. Preserved here rather than left to the model's fresh descriptive tags, which are
    // replaced wholesale. The user removes it in the UI (or tells an agent) to escalate the task back
    // to real work — that removal must stick, so it is only preserved when already present, never re-added.
    const CONTROL_TAGS = new Set(["parking-lot", "blocked", REMINDER_TAG]);
    const tagsById = new Map(slice.map((t) => [t.id, (t.tags ?? []).map((x) => String(x).toLowerCase())]));
    const updates = assignments.map((a) => {
      const llmTags = Array.isArray(a.tags) ? a.tags.map((t) => String(t).toLowerCase()) : [];
      const preserved = (tagsById.get(a.id) ?? []).filter((t) => CONTROL_TAGS.has(t));
      const tags = Array.from(new Set([...llmTags, ...preserved])).slice(0, 5);
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

    // Chain: grooming assigns + ranks the backlog, but "Up next" is auto-work's lane, not grooming's
    // (grooming never writes status — see git history / CLAUDE.md). So after a successful write, kick ONE
    // auto-work pass to top each agent's UP_NEXT up to cap 3 from its freshly-ranked BACKLOG. Auto-work
    // buckets by journey status, so any task journey already scheduled to UP_NEXT is KEPT and only counts
    // against the cap — it tops up around journey's schedule rather than overriding it. The mirror sync is
    // async (~1-3s), so wait a beat first, letting auto-work read the new ranks/assignments; bounded and
    // non-fatal so a slow/failed pass never hangs or fails the grooming turn.
    let promoted = 0;
    let autoworkNote = "";
    if (written > 0) {
      try {
        await new Promise((r) => setTimeout(r, MIRROR_SYNC_WAIT_MS));
        const { runScheduledAutoWork } = await import("./autowork.server");
        const aw = await withTimeout(
          // promoteOnly: fill "Up next" from the freshly-ranked backlog ONLY. Grooming must NOT trigger
          // research turns or review flips — those run on the auto-work cadence, behind the confirm gate.
          runScheduledAutoWork(caller, { force: true, promoteOnly: true }),
          AUTOWORK_DEADLINE_MS,
          "post-groom autowork",
        );
        if (aw?.ok) {
          promoted = aw.promoted ?? 0;
          autoworkNote =
            promoted > 0
              ? ` Filled "Up next": ${promoted} top-ranked ${promoted === 1 ? "task" : "tasks"} promoted (capped at 3 per agent, keeping anything journey already scheduled).`
              : " Every agent's \"Up next\" was already full or nothing qualified to promote.";
        }
      } catch {
        /* auto-work chain slow/failed — grooming still succeeded; the nightly pass will top up later */
      }
    }

    return JSON.stringify({
      groomed: written,
      promoted,
      total: assignments.length,
      _timings: { readMs: _readMs, classifyMs: _classifyMs, writeMs: _writeMs, tasks: slice.length },
      note:
        (written === 0
          ? "Planned the assignments, but the write to the task board didn't confirm — try again in a moment."
          : written < assignments.length
            ? `Wrote ${written} of ${assignments.length}; board reflects changes within a few seconds (async sync).`
            : "Assignments + priority written back to the task board; the Huddle board reflects them within a few seconds (async sync).") +
        autoworkNote,
      order: ranked.map((a, i) => {
        const t = slice.find((s) => s.id === a.id);
        const agent = AGENTS.find((ag) => ag.id === a.assigned_agent);
        return { rank: i + 1, title: t?.title, assignee: agent?.name, priority: a.priority, why: a.reason };
      }),
    });
  } catch (err) {
    return JSON.stringify({ error: "groom_failed", message: err instanceof Error ? err.message : String(err) });
  }
}
