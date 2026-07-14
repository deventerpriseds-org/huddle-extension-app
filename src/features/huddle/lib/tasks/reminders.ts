// Huddle-native reminders. When the user asks "remind me in 30 minutes to ...", the scheduling agent
// calls `schedule_reminder`, which persists the reminder (chat.reminders). The per-minute drain
// (run-turn route / journey cron) fires due reminders: it pushes the user's phone (if Web Push is
// set up) and delivers the reminder into THIS Huddle conversation, where the client's poll renders it
// as a message from the agent. Unlike journey's send_chat_message, this fires where the user asked.

import { AGENT_BY_ID, type AgentId } from "../../data/agents";

export const SCHEDULE_REMINDER_TOOL = {
  type: "function",
  name: "schedule_reminder",
  description:
    "Schedule a reminder that pings the user LATER, in this conversation (plus a phone notification if they're away). Call this whenever the user asks to be reminded, notified, pinged, nudged, or messaged at a later time or after a delay — e.g. 'remind me in 30 minutes to stretch', 'ping me at 3pm', 'nudge me tonight'. A reminder is a timed nudge, NOT a backlog task, so do not also create a task for it. Only tell the user the reminder is set AFTER this tool returns success; if it returns an error, tell them it failed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description: "What to remind the user about, as the reminder message itself (e.g. 'drink water').",
      },
      delay_minutes: {
        type: "number",
        description: "Fire this many minutes from now. Use for 'in N minutes/hours' (e.g. 90 for 'in 1.5 hours').",
      },
      at_time: {
        type: "string",
        description: "Local clock time as HH:MM (24-hour) to fire today, or tomorrow if already past. Use for 'at 3pm' → '15:00'.",
      },
    },
    required: ["text"],
  },
  strict: false,
} as const;

export const REMINDER_SYSTEM_HINT =
  "When the user asks to be reminded, notified, pinged, nudged, or messaged at a later time or after a delay ('remind me in 30 minutes', 'ping me at 3pm'), you MUST call `schedule_reminder` — do not create a task and do not claim you've set a reminder unless the tool returns success. If it returns an error, say plainly that you couldn't set it.";

type Caller = { entra_object_id?: string; entra_email?: string };

// ms that `tz` is ahead of UTC at the given instant (reliable via Intl parts).
function tzOffsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(atMs))) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - atMs;
}

/** Resolve delay_minutes / at_time into an absolute fire time (ms), or null if neither is usable. */
function resolveDueMs(args: Record<string, unknown>, timeZone: string | undefined, nowMs: number): number | null {
  const delay = typeof args.delay_minutes === "number" ? args.delay_minutes : Number(args.delay_minutes);
  if (Number.isFinite(delay) && delay > 0) return nowMs + Math.round(delay * 60_000);

  const at = typeof args.at_time === "string" ? args.at_time.trim() : "";
  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Math.min(23, Math.max(0, +m[1]));
    const mm = Math.min(59, Math.max(0, +m[2]));
    const tz = timeZone || "UTC";
    const off = tzOffsetMs(tz, nowMs);
    // Today's date parts in tz:
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const dm: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(nowMs))) dm[p.type] = p.value;
    let target = Date.UTC(+dm.year, +dm.month - 1, +dm.day, hh, mm, 0) - off;
    if (target <= nowMs) target += 86_400_000; // already past today → tomorrow
    return target;
  }
  return null;
}

/**
 * Persist a reminder for the caller. Honest result: only returns { scheduled: true } when the row was
 * actually written. `huddleId` is the conversation to deliver back into; `agentId` is who scheduled it.
 */
export async function dispatchScheduleReminder(
  caller: Caller | undefined,
  args: Record<string, unknown>,
  huddleId: string,
  agentId: string,
  timeZone: string | undefined,
): Promise<string> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return JSON.stringify({ error: "missing_text", message: "A reminder needs something to say." });

  const nowMs = Date.now();
  const dueMs = resolveDueMs(args, timeZone, nowMs);
  if (dueMs == null) {
    return JSON.stringify({ error: "missing_time", message: "Tell me when — a delay (e.g. 30 minutes) or a time (e.g. 3pm)." });
  }

  let email: string | null = null;
  try {
    const { resolveTaskEmail } = await import("../journey/identity");
    email = (await resolveTaskEmail(caller)) ?? caller?.entra_email ?? null;
  } catch {
    email = caller?.entra_email ?? null;
  }

  try {
    const { createReminder } = await import("./turns.server");
    const id = `rem-${nowMs.toString(36)}-${Math.round((dueMs % 1_000_000))}`;
    await createReminder({ id, userEmail: email, huddleId, agentId, text, dueAtMs: dueMs });
    const minutes = Math.round((dueMs - nowMs) / 60_000);
    const whenIso = new Date(dueMs).toISOString();
    return JSON.stringify({
      scheduled: true,
      id,
      due_at: whenIso,
      in_minutes: minutes,
      message: `Reminder set — I'll ping you here${minutes >= 1 ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " shortly"}.`,
    });
  } catch (err) {
    return JSON.stringify({ error: "reminder_write_failed", message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Fire all due reminders (called by the per-minute drain). Marks each fired (atomic claim), pushes the
 * user's phone, and leaves it for the client to render in-chat via getFiredRemindersSince. Returns count.
 */
export async function fireDueReminders(max = 25): Promise<number> {
  const { claimDueReminders } = await import("./turns.server");
  const due = await claimDueReminders(max);
  if (!due.length) return 0;
  const { sendPushToUser } = await import("../push/push.server");
  await Promise.all(
    due.map(async (r) => {
      const name = r.agent_id ? AGENT_BY_ID[r.agent_id as AgentId]?.name ?? "Huddle" : "Huddle";
      try {
        await sendPushToUser(r.user_email, {
          title: `⏰ Reminder from ${name}`,
          body: r.text.slice(0, 140),
          url: "/",
          tag: `reminder-${r.id}`,
        });
      } catch {
        /* push best-effort; the in-chat delivery still happens */
      }
    }),
  );
  return due.length;
}
