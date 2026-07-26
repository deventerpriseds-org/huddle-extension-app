// Server-side AUTO backlog grooming. The scrum master (Terry) grooms/triages/assigns the backlog on
// a cadence (journey pg_cron POSTs /api/public/run-grooming a few times a day), NOT only when asked.
// It reuses Terry's existing grooming engine (dispatchGroomBacklog — LLM assign/tag/priority/rank +
// writeback to journey) and, when something actually changed, surfaces a warm proactive summary in
// Terry's OWN DM as a durable turn — which rides the existing send_push away-notification (Android
// bridge) with no new sender. A change-detection gate skips a re-groom of an unchanged backlog so the
// cadence never churns or spams. Called by the run-grooming public route (and usable for a manual/test
// trigger with force:true).

import { dispatchGroomBacklog } from "./groom";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface GroomRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  groomed?: number;
  blocked?: number;
  runId: string;
}

/**
 * A stable signature over the backlog's grooming-INDEPENDENT shape: open tasks' id/title/status/
 * due_date, sorted by id. Deliberately EXCLUDES assigned_agent/tags/priority/rank — the fields
 * grooming itself writes — so re-grooming an unchanged backlog produces the same signature and is
 * skipped, while a genuinely new/edited/removed task changes it and triggers a fresh groom.
 */
export function backlogSignature(
  tasks: { id: string; title?: string | null; status?: string | null; due_date?: string | null }[],
): string {
  const canon = tasks
    .map((t) => `${t.id}|${(t.title ?? "").trim().toLowerCase()}|${t.status ?? ""}|${t.due_date ?? ""}`)
    .sort()
    .join("\n");
  // djb2 — deterministic, dependency-free; collisions are astronomically unlikely for this use.
  let h = 5381;
  for (let i = 0; i < canon.length; i++) h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
  return `${tasks.length}:${h.toString(36)}`;
}

interface GroomJson {
  error?: string;
  groomed?: number;
  total?: number;
  order?: { rank?: number; title?: string; assignee?: string; priority?: string; why?: string }[];
}

/** Compact human-readable brief of what grooming just did, handed to Terry to narrate in his own words. */
function buildBrief(p: GroomJson): string {
  const order = Array.isArray(p.order) ? p.order.slice(0, 5) : [];
  const lines: string[] = [`Assignments written to the board: ${p.groomed ?? 0} of ${p.total ?? 0}.`];
  if (order.length) {
    lines.push("Top priorities (rank — title — owner — priority):");
    for (const o of order) {
      lines.push(`  ${o.rank}. ${o.title} — ${o.assignee} — ${o.priority}${o.why ? ` (${o.why})` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Enqueue Terry's proactive grooming summary as a durable turn in his OWN DM (dm-terry-locke) and run
 * it to completion. Because it goes through executeClaimedTurn, its completion fires send_push — the
 * user gets the away-notification for free. Idempotent id so a retried cadence fire can't double-post.
 */
async function surfaceSummary(opts: {
  email: string;
  tz: string;
  caller: Caller;
  parsed: GroomJson;
  runId: string;
}): Promise<void> {
  const brief = buildBrief(opts.parsed);
  const directive =
    `You (Terry Locke, scrum master) just finished an AUTOMATIC backlog grooming pass for the user — ` +
    `this ran on a schedule; the user did NOT ask just now. Here is exactly what you did:\n\n${brief}\n\n` +
    `Send ONE short, warm proactive message summarizing it in your own words: how many tasks you assigned/` +
    `reprioritized and the top 1–3 priorities and who owns them. This is a REPORT-ONLY turn: the grooming ` +
    `is already written to the board, so under no circumstances call groom_backlog or any other tool again, ` +
    `and do not paste raw JSON. Keep it to 2–4 sentences.`;

  const payload = {
    text: directive,
    huddleId: "dm-terry-locke",
    scope: "one-to-one",
    members: ["terry-locke"],
    targetAgentId: "terry-locke",
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { "terry-locke": { backend: "openai", journey: { enabled: true } } },
    timeZone: opts.tz,
    caller: opts.caller,
  };
  const id = `groom-summary-${opts.runId}`;
  const { enqueueTurn } = await import("./turns.server");
  const fresh = await enqueueTurn(id, "dm-terry-locke", opts.email, payload);
  if (fresh) {
    const { runTurnById } = await import("../huddle.functions");
    await runTurnById(id); // run inline to completion so send_push fires now
  }
}

/**
 * Run one auto-grooming pass for a user. On a cadence fire, grooms ONLY when the backlog changed since
 * the last groom (the signature gate); a manual/test run passes force:true to bypass the gate. Grooms
 * via Terry's engine, advances the watermark, and surfaces a proactive summary + push when something
 * meaningful changed.
 */
export async function runScheduledGrooming(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<GroomRunResult> {
  const runId =
    opts.runId?.trim() || `groom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getTasksForUser, getGroomSignature, setGroomSignature } = await import("./tasks.server");
  const tasks = await getTasksForUser(email);
  const signature = backlogSignature(tasks);

  // Change gate: an unchanged backlog is skipped (no groom, no push) unless force'd (manual/test run).
  if (!opts.force) {
    const prev = await getGroomSignature(email);
    if (prev !== null && prev === signature) {
      return { ok: true, skipped: true, reason: tasks.length ? "unchanged" : "empty", runId };
    }
  }
  if (!tasks.length) {
    await setGroomSignature(email, signature); // record empty shape; no summary/push
    return { ok: true, skipped: true, reason: "empty", runId };
  }

  // Groom via Terry's engine (LLM assign/tag/priority/rank + writeback to journey). Unlike the in-chat
  // tool (capped at 25 to beat the live-turn timeout), the scheduled path grooms the WHOLE open backlog
  // per pass — bounded at 80 so a very large backlog can't rate-limit OpenAI (the remainder rotates in on
  // the next cadence fire, driven by change/next slot). Classification runs in concurrent 5-task chunks.
  const SCHEDULED_MAX = 80;
  const passLimit = Math.min(tasks.length, SCHEDULED_MAX);
  let parsed: GroomJson = {};
  try {
    parsed = JSON.parse(await dispatchGroomBacklog(caller, { limit: passLimit }, { maxLimit: SCHEDULED_MAX })) as GroomJson;
  } catch {
    parsed = {};
  }
  if (parsed.error || typeof parsed.groomed !== "number") {
    // Hard failure — do NOT advance the watermark, so the next cadence fire retries.
    return { ok: false, skipped: false, reason: parsed.error ?? "groom_failed", runId };
  }

  // Classification + write completed — advance the watermark so an unchanged backlog is skipped next fire.
  await setGroomSignature(email, signature);

  const groomed = Number(parsed.groomed) || 0;
  // Nothing meaningful to report → no proactive ping (avoids "nothing changed" noise).
  if (groomed === 0) {
    return { ok: true, skipped: false, groomed: 0, runId };
  }

  await surfaceSummary({ email, tz, caller, parsed, runId });
  return { ok: true, skipped: false, groomed, runId };
}
