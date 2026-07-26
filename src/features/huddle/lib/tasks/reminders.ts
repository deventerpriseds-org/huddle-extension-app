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
    "Schedule a reminder or alarm that pings the user LATER, in this conversation and on their phone. Call this whenever the user asks to be reminded, notified, pinged, nudged, messaged, woken, or alarmed at a later time or after a delay — e.g. 'remind me in 30 minutes to stretch', 'ping me at 3pm', 'wake me at 6am', 'set an alarm for 20 minutes'. DEFAULT to kind:'alarm' whenever the user directly asks to be reminded/woken — an alarm rings full-screen with sound on the phone and can be snoozed or dismissed, so it's unmissable (this is what users mean by 'remind me'). Only use kind:'reminder' (a quiet heads-up banner) when the user explicitly wants something gentle/low-key. A reminder/alarm is a timed nudge, NOT a backlog task, so do not also create a task for it. Only tell the user it's set AFTER this tool returns success; if it returns an error, tell them it failed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description: "What to remind the user about, as the message itself (e.g. 'drink water', 'stand-up meeting').",
      },
      kind: {
        type: "string",
        enum: ["reminder", "alarm"],
        description: "'alarm' (DEFAULT for any direct 'remind me / wake me / set an alarm') = full-screen, rings with sound until snoozed or dismissed. 'reminder' = a quiet heads-up banner; use ONLY when the user explicitly wants a gentle/low-key nudge.",
      },
      delay_minutes: {
        type: "number",
        description: "Fire this many minutes from now. Use for 'in N minutes/hours' (e.g. 90 for 'in 1.5 hours').",
      },
      at_time: {
        type: "string",
        description: "Local clock time as HH:MM (24-hour) to fire today, or tomorrow if already past. Use for 'at 3pm' → '15:00', 'wake me at 6am' → '06:00'.",
      },
    },
    required: ["text"],
  },
  strict: false,
} as const;

export const REMINDER_SYSTEM_HINT =
  "When the user asks to be reminded, notified, pinged, nudged, messaged, woken, or alarmed at a later time or after a delay ('remind me in 30 minutes', 'ping me at 3pm', 'wake me at 6am', 'set an alarm'), you MUST call `schedule_reminder`. DEFAULT kind to 'alarm' (full-screen, rings with sound, snooze/dismiss) whenever the user directly asks to be reminded or woken — that is what they mean. Use kind:'reminder' (a quiet heads-up) only when the user explicitly wants something gentle/low-key. Do not create a task, and do not claim you've set it unless the tool returns success. If it returns an error, say plainly that you couldn't set it.";

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

  // Default to a full-screen alarm: when the user directly asks to be reminded they want an
  // unmissable, snooze/dismiss-able alert (their stated preference). Only an explicit gentle/system
  // nudge passes kind:'reminder' for the quiet heads-up.
  const kind = args.kind === "reminder" ? "reminder" : "alarm";
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
    await createReminder({ id, userEmail: email, huddleId, agentId, text, kind, dueAtMs: dueMs });
    const minutes = Math.round((dueMs - nowMs) / 60_000);
    const whenIso = new Date(dueMs).toISOString();
    const label = kind === "alarm" ? "Alarm" : "Reminder";
    return JSON.stringify({
      scheduled: true,
      id,
      kind,
      due_at: whenIso,
      in_minutes: minutes,
      message: `${label} set — I'll ${kind === "alarm" ? "ring you" : "ping you here"}${minutes >= 1 ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " shortly"}.`,
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
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  await Promise.all(
    due.map(async (r) => {
      const name = r.agent_id ? AGENT_BY_ID[r.agent_id as AgentId]?.name ?? "Huddle" : "Huddle";
      const isAlarm = r.kind === "alarm";
      const title = isAlarm ? "⏰ Alarm" : `Reminder from ${name}`;
      // Phone delivery via journey's native push → the Android bridge. A reminder lands as a heads-up
      // (channel `messages`); an alarm lands as the bridge's full-screen, ring-until-dismissed alarm
      // (channel `calendar_events`). Requires the user's device to be registered in journey.
      if (r.user_email) {
        try {
          // Source-aware deep link: target the agent's own 1:1 (where the reminder/alarm is rendered
          // in-chat) so tapping the phone notification opens THAT channel — same pattern as agent
          // replies (executeClaimedTurn). Harmless if the bridge app's baseUrl isn't Huddle; only
          // resolves once the installed APK targets the Huddle SWA. No agent → home (default).
          const huddleId = r.agent_id ? `dm-${r.agent_id}` : "";
          await invokeJourneyTool({
            toolName: "send_push",
            args: {
              title,
              body: r.text.slice(0, 200),
              channel: isAlarm ? "calendar_events" : "task-reminders",
              // Target the standalone Huddle bridge app only (endpoint `fcm:app:huddle:%`) so a Huddle
              // reminder/alarm doesn't also duplicate onto journey's web + bridge subscriptions.
              app: "huddle",
              ...(huddleId
                ? { data: { deepLink: `/?huddle=${huddleId}`, source: isAlarm ? "huddle-alarm" : "huddle-reminder", huddleId } }
                : {}),
            },
            caller: { entra_email: r.user_email },
            context: { source: "huddle" },
          });
        } catch {
          /* journey push best-effort */
        }
      }
      // Huddle's own Web Push (no-op until Huddle VAPID keys are set) — covers browser-only users.
      try {
        await sendPushToUser(r.user_email, {
          title,
          body: r.text.slice(0, 140),
          url: "/",
          tag: `reminder-${r.id}`,
        });
      } catch {
        /* best-effort; the in-chat delivery still happens */
      }
    }),
  );
  return due.length;
}
