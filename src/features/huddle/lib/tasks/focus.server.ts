// WHAT:       "Focus on these": take a list the owner typed or said, start the tasks that already exist,
//             create the ones that don't and start those too. ONE implementation behind both surfaces —
//             the Priorities tab's input (focusWidgetItems in widgets.functions.ts) and the `focus_on`
//             agent tool (huddle.functions.ts, both backends).
// WHY:        Owner, 2026-10-16: "i should be able to reply to the priority message question with a list
//             of items i want to work on and if they exist, it should start them, but if they dont, it
//             should create the tasks first then start them. this needs to be a streamlined ability if i
//             ask iris or if i type in the text input section of the priorities tab. currently typing in
//             the priorities tab switches views to iris 1:1 ... look at how the focus view works in
//             journey". journey's Focus view creates in place (QuickTaskInput → parse_and_create_tasks)
//             and its Start button is status DOING; this does both, for a list, without leaving the tab.
// HOW:        Every write goes to JOURNEY (canonical) through the same tools the widget buttons already
//             use: quick_create_task (create), set_priority_rank (star into This Week — push.server's
//             rank), update_task status DOING (the widget's "start"). The This Week order is Huddle's
//             own week_order, with the focused items moved to the front in the order given.
// SUPERSEDES: the Priorities compose row's hand-off to Iris's composer (WidgetComposeRow prefill).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/focus.test.ts

import {
  isFocusCandidate,
  matchAll,
  splitFocusText,
  summarizeFocus,
  type FocusCandidate,
  type FocusItemResult,
  type FocusMatch,
} from "./focus";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface FocusInput {
  /** Free text: one or more items. */
  text?: string;
  /** Pre-split items; `task_id` when the caller (an agent) already knows which task is meant. */
  items?: { title: string; task_id?: string | null }[];
}

export interface FocusOutcome {
  ok: boolean;
  results: FocusItemResult[];
  summary: string;
  error?: string;
}

const MAX_ITEMS = 12;

/** Resolve the items still unmatched with ONE small model call. Only ids from `rows` are accepted, and
 *  any failure (no key, timeout, bad JSON) leaves the item unmatched — it is then CREATED, never guessed. */
async function matchByModel(items: FocusMatch[], rows: readonly FocusCandidate[]): Promise<void> {
  const pending = items.filter((m) => !m.taskId);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!pending.length || !rows.length || !apiKey) return;
  const taken = new Set(items.map((m) => m.taskId).filter(Boolean) as string[]);
  const pool = rows.filter((r) => !taken.has(r.id)).slice(0, 300);
  const byId = new Map(pool.map((r) => [r.id, r]));
  const system =
    "You match what a person said they want to work on to THEIR OWN existing task list. For each item, " +
    "return the id of the ONE task it clearly refers to (same piece of work, even if worded differently), " +
    'or null when none clearly does. Never match on a shared word alone. Reply as JSON: {"matches":[{"i":<item index>,"id":<task id or null>}]}.';
  const user =
    `Items:\n${pending.map((m, i) => `${i}: ${JSON.stringify(m.item)}`).join("\n")}\n\n` +
    `Tasks:\n${pool.map((r) => `${r.id}: ${JSON.stringify(r.title)}`).join("\n")}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.FOCUS_MATCH_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return;
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}") as {
      matches?: { i?: unknown; id?: unknown }[];
    };
    for (const m of parsed.matches ?? []) {
      const i = typeof m.i === "number" ? m.i : Number(m.i);
      const id = typeof m.id === "string" ? m.id : null;
      const target = Number.isInteger(i) ? pending[i] : undefined;
      const row = id ? byId.get(id) : undefined;
      if (!target || !row || taken.has(row.id)) continue;
      taken.add(row.id);
      target.taskId = row.id;
      target.title = row.title;
      target.by = "model";
    }
  } catch {
    /* best-effort: unmatched items are created */
  }
}

/** Create one task in journey and return its id (journey's /tool returns created rows under `tasks`). */
async function createTask(caller: Caller, title: string): Promise<{ id: string | null; error?: string }> {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const r = await invokeJourneyTool({
    toolName: "quick_create_task",
    args: { title: title.slice(0, 160) },
    caller,
    context: { source: "huddle" },
  });
  if (!r.ok) return { id: null, error: r.error ?? "journey rejected the create" };
  const fromRows = (r.tasks ?? []).map((t) => (t as { id?: unknown }).id).find((id) => typeof id === "string");
  if (typeof fromRows === "string") return { id: fromRows };
  try {
    const out = JSON.parse(r.output) as { tasks?: { id?: string }[]; task?: { id?: string }; id?: string };
    const id = out.tasks?.[0]?.id ?? out.task?.id ?? out.id ?? null;
    return id ? { id } : { id: null, error: "created, but journey returned no id" };
  } catch {
    return { id: null, error: "created, but journey returned no id" };
  }
}

/** Star (This Week) and start (DOING) one task. A parked task is un-parked — he asked for it by name. */
async function starAndStart(
  caller: Caller,
  taskId: string,
  tags: readonly unknown[] | null | undefined,
): Promise<{ starred: boolean; started: boolean; error?: string }> {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const { PUSH_RANK } = await import("./push.server");
  const { ACTION_STATUS, PARKING_LOT_TAG } = await import("./widgets.server");
  const star = await invokeJourneyTool({
    toolName: "set_priority_rank",
    args: { task_id: taskId, rank: PUSH_RANK },
    caller,
    context: { source: "huddle" },
  });
  const tagList = (tags ?? []).map((t) => String(t));
  const parked = tagList.some((t) => t.toLowerCase() === PARKING_LOT_TAG);
  const start = await invokeJourneyTool({
    toolName: "update_task",
    args: {
      task_id: taskId,
      status: ACTION_STATUS.start,
      // update_task REPLACES tags, so only send them when un-parking, and then send the rest intact.
      ...(parked ? { tags: tagList.filter((t) => t.toLowerCase() !== PARKING_LOT_TAG) } : {}),
    },
    caller,
    context: { source: "huddle" },
  });
  return {
    starred: !!star.ok,
    started: !!start.ok,
    error: start.ok ? undefined : (start.error ?? "journey rejected the start"),
  };
}

/**
 * Start everything in `input` for the signed-in owner. NEVER THROWS.
 * Order of work per item: an explicit task_id (ownership-checked) → deterministic title match → one
 * model call for the rest → create what is still unmatched → star + start each → front of This Week.
 */
export async function focusOn(caller: Caller, input: FocusInput): Promise<FocusOutcome> {
  const fail = (error: string): FocusOutcome => ({ ok: false, results: [], summary: error, error });
  try {
    if (!caller?.entra_email) return fail("Sign-in required.");
    const { resolveTaskEmail } = await import("../journey/identity");
    const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;

    const given = (input.items ?? [])
      .map((i) => ({ title: String(i.title ?? "").trim(), task_id: i.task_id ? String(i.task_id) : null }))
      .filter((i) => i.title || i.task_id);
    const list = given.length ? given : splitFocusText(input.text ?? "").map((title) => ({ title, task_id: null }));
    if (!list.length) return fail("Nothing to start — list what you want to work on.");
    if (list.length > MAX_ITEMS) return fail(`That's ${list.length} items; send at most ${MAX_ITEMS} at once.`);

    const { getBoardTasks, getWeekOrder, setWeekOrder } = await import("./tasks.server");
    const rows = (await getBoardTasks(email)) as unknown as (FocusCandidate & { tags?: string[] | null })[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    // 1. explicit ids the agent passed — only the owner's own, open tasks count.
    const matches: FocusMatch[] = list.map((i) => {
      const hit = i.task_id ? byId.get(i.task_id) : undefined;
      const row = hit && isFocusCandidate(hit) ? hit : undefined;
      return row
        ? { item: i.title || row.title, taskId: row.id, title: row.title, by: "id" as const }
        : { item: i.title, taskId: null, title: null, by: null };
    });
    // 2. deterministic title match for the rest, never reusing a task already claimed.
    const claimed = new Set(matches.map((m) => m.taskId).filter(Boolean) as string[]);
    const rest = rows.filter((r) => !claimed.has(r.id));
    const det = matchAll(matches.filter((m) => !m.taskId).map((m) => m.item).filter(Boolean), rest);
    let k = 0;
    for (const m of matches) if (!m.taskId && m.item) Object.assign(m, det[k++]);
    // 3. one model call for whatever wording the deterministic pass could not settle.
    await matchByModel(matches, rows.filter(isFocusCandidate));

    // 4. create → star → start, in the order given.
    const results: FocusItemResult[] = [];
    for (const m of matches) {
      let taskId = m.taskId;
      let created = false;
      let error: string | undefined;
      if (!taskId && !m.item) {
        results.push({ item: "", taskId: null, title: "(unknown task)", created: false, started: false, starred: false, matchedBy: null, error: "task not found" });
        continue;
      }
      if (!taskId) {
        const c = await createTask(caller, m.item);
        taskId = c.id;
        created = !!c.id;
        error = c.error;
      }
      if (!taskId) {
        results.push({ item: m.item, taskId: null, title: m.item, created: false, started: false, starred: false, matchedBy: null, error });
        continue;
      }
      const s = await starAndStart(caller, taskId, byId.get(taskId)?.tags);
      results.push({
        item: m.item,
        taskId,
        title: m.title ?? m.item,
        created,
        started: s.started,
        starred: s.starred,
        matchedBy: m.by,
        error: s.error,
      });
    }

    // 5. This Week order: the focused tasks first, in the order he gave them, then everything else.
    const focused = results.filter((r) => r.taskId && r.starred).map((r) => r.taskId as string);
    if (focused.length) {
      try {
        const prior = await getWeekOrder(email);
        await setWeekOrder(email, [...focused, ...prior.filter((id) => !focused.includes(id))]);
      } catch {
        /* ordering is cosmetic; the stars and starts already landed */
      }
    }

    return { ok: results.some((r) => r.started), results, summary: summarizeFocus(results) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
