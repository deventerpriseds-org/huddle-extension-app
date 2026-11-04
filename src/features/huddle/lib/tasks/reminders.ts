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
      task_id: {
        type: "string",
        description: "ONLY when this reminder/alarm is about a task ALREADY on the user's board: that task's id (from schedule_and_priorities results, or a task id you were given). It makes the phone alarm show Done/Doing that update that task. Omit it for ordinary reminders like 'check the mail in 15 minutes' — never create a task just to get an id.",
      },
    },
    required: ["text"],
  },
  strict: false,
} as const;

export const REMINDER_SYSTEM_HINT =
  "When the user asks to be reminded, notified, pinged, nudged, messaged, woken, or alarmed at a later time or after a delay ('remind me in 30 minutes', 'ping me at 3pm', 'wake me at 6am', 'set an alarm'), you MUST call `schedule_reminder`. DEFAULT kind to 'alarm' (full-screen, rings with sound, snooze/dismiss) whenever the user directly asks to be reminded or woken — that is what they mean. Use kind:'reminder' (a quiet heads-up) only when the user explicitly wants something gentle/low-key. Do not create a task, and do not claim you've set it unless the tool returns success. If it returns an error, say plainly that you couldn't set it." +
  " If the user gives only a VAGUE timeframe ('sometime this week', 'later', 'this weekend', 'in the morning', 'at some point'), do NOT interrogate them for an exact time before acting — pick a sensible default slot yourself (e.g. a weekday at 6pm, tomorrow at 9am, or the next reasonable open time), call `schedule_reminder` with it, and THEN tell them exactly what you set and that they can move it. Capturing the reminder at a best-assumption time they can adjust in one tap always beats withholding it behind a 'what time?' question.";

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

  // Optional link to an EXISTING board task (never created here — a reminder is not a task). Only
  // kept when the id is one of the caller's open mirror tasks, so a model can't attach an alarm to a
  // task it invented or to someone else's. A linked alarm carries the id to the phone, where its
  // Done/Doing buttons update that journey task.
  let taskId: string | null = null;
  const requestedTaskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (requestedTaskId && email) {
    try {
      const { getTasksForUser } = await import("./tasks.server");
      const open = await getTasksForUser(email);
      if (open.some((t) => t.id === requestedTaskId)) taskId = requestedTaskId;
    } catch {
      /* unverifiable → leave unlinked; the reminder itself still gets set */
    }
  }

  try {
    const { createReminder } = await import("./turns.server");
    const id = `rem-${nowMs.toString(36)}-${Math.round((dueMs % 1_000_000))}`;
    await createReminder({ id, userEmail: email, huddleId, agentId, text, kind, dueAtMs: dueMs, taskId });
    const minutes = Math.round((dueMs - nowMs) / 60_000);
    const whenIso = new Date(dueMs).toISOString();
    const label = kind === "alarm" ? "Alarm" : "Reminder";
    return JSON.stringify({
      scheduled: true,
      id,
      kind,
      due_at: whenIso,
      in_minutes: minutes,
      task_linked: taskId != null,
      ...(requestedTaskId && taskId == null ? { task_link_note: "task_id was not one of the user's open tasks, so this reminder is not linked to a task" } : {}),
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
      // A reminder linked to a board task that is already DONE has nothing left to say: no alarm, no
      // "did you get it done?" close-out. Cancel it instead of firing.
      if (r.task_id) {
        const { getTaskStatus } = await import("./tasks.server");
        if ((await getTaskStatus(r.task_id)) === "DONE") {
          const { cancelReminder } = await import("./turns.server");
          await cancelReminder(r.id);
          return;
        }
      }
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
              data: {
                ...(huddleId
                  ? { deepLink: `/?huddle=${huddleId}`, source: isAlarm ? "huddle-alarm" : "huddle-reminder", huddleId }
                  : {}),
                // Unique per reminder so several firing close together each get their own notification
                // (the bridge keys on `tag`; a shared tag would collapse them to one). See executeClaimedTurn.
                notificationId: `rem-${r.id}`,
                tag: `rem-${r.id}`,
                // Linked to a journey task → journey mints a signed action token and the phone alarm
                // shows Done/Doing that update THAT task (no login needed on the phone). Unlinked
                // reminders stay Confirm/Snooze/Dismiss.
                ...(r.task_id ? { taskId: r.task_id } : {}),
              },
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

      // CLOSE-OUT for a REMIND-mode task reminder. Without this the fired reminder just lapses: the
      // task silently re-enters grooming and gets proposed from scratch, so an errand the user already
      // did comes back as a fresh confirm-ask. That is how the 34-item pile was built, and it would
      // rebuild on a slower clock. Instead the nudge itself becomes the decision point — done, or a
      // new date.
      //
      // Enqueued as a REAL durable turn (not a bare push) so it rides the same path as every other
      // reply: it lands in the transcript, survives a closed app, and fires the existing away-push. No
      // new sender, no parallel delivery mechanism. Idempotent id — a retry cannot double-ask.
      if (r.task_id && r.user_email && r.agent_id) {
        try {
          const { enqueueTurn } = await import("./turns.server");
          const huddleId = `dm-${r.agent_id}`;
          const directive =
            `The reminder you set for the user's task "${r.text}" just came due. This is a CLOSE-OUT, ` +
            `not new work: they own this task, you only own the follow-up.\n` +
            `Send ONE short, warm line asking whether they got it done — nothing else, no plan, no ` +
            `offer to do it for them, no restating the task's history.\n` +
            `If they say it's DONE, call update_task to mark it done and confirm briefly. If they want ` +
            `more time, ask for the new day/time and call schedule_reminder for it with task_id "${r.task_id}" so the new alarm stays linked to this task. If they no longer ` +
            `want it, offer to archive it. Do NOT create a new task and do NOT propose a deliverable.`;
          const fresh = await enqueueTurn(`taskremind-closeout-${r.id}`, huddleId, r.user_email, {
            text: directive,
            huddleId,
            scope: "one-to-one",
            members: [r.agent_id],
            targetAgentId: r.agent_id,
            history: [],
            router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
            agents: { [r.agent_id]: { backend: "openai" } },
            caller: { entra_email: r.user_email },
            notify: "push", // a due reminder is exactly the case that SHOULD reach the phone
            internal: true,
          });
          if (fresh) {
            // Same inline-run pattern the standup digest uses (surfaceDigest): run it now so the
            // close-out's push fires with the reminder rather than waiting for the next drain tick.
            const { runTurnById } = await import("../huddle.functions");
            await runTurnById(`taskremind-closeout-${r.id}`);
          }
        } catch {
          /* close-out is best-effort — the push above already landed; the task simply becomes eligible */
        }
      }
    }),
  );
  return due.length;
}

// =================================================================================================
// LIST / CANCEL / MOVE — ADDITIVE management tools over the SAME store (chat.reminders).
//
// Before these, `schedule_reminder` was the only reminder tool, so "cancel the 2pm reminder" or "push
// that alarm to 4" could not be done by any agent. Nothing above this line is changed by them: they
// reuse schedule_reminder's owner resolution (resolveTaskEmail ?? entra_email) and its time zone (the
// turn's timeZone, the one `at_time` is interpreted in), and only ever act on a still-PENDING row of
// the caller's own, so a fired reminder cannot be un-fired and a cancelled one cannot come back.
//
// The ambiguity rule is structural, not a prompt: when more than one reminder matches the
// description, the mutating tools return the CANDIDATES and change nothing, so the agent has to ask.
// =================================================================================================

const SELECTOR_PROPS = {
  reminder_id: {
    type: "string",
    description: "The reminder's id, from list_reminders (or from schedule_reminder's result). Most precise; use it whenever you have it.",
  },
  about: {
    type: "string",
    description: "Words from what the reminder says, e.g. 'dentist' or 'drink water'. Matches reminders whose text contains ALL of these words.",
  },
  currently_at: {
    type: "string",
    description: "The time it is CURRENTLY set for, as local HH:MM (24-hour), e.g. '14:00' for 'the 2pm reminder'.",
  },
  on_date: {
    type: "string",
    description: "The local date it is currently set for, YYYY-MM-DD. Only needed to tell apart two reminders at the same time on different days.",
  },
  kind: {
    type: "string",
    enum: ["reminder", "alarm"],
    description: "Only when the user said which: 'alarm' or 'reminder'.",
  },
} as const;

export const LIST_REMINDERS_TOOL = {
  type: "function",
  name: "list_reminders",
  description:
    "List the user's UPCOMING reminders and alarms (the ones set with schedule_reminder that have not gone off yet), soonest first, with each one's id, text, kind and time in the user's time zone. Call it for 'what reminders do I have', 'what alarms are set', or before cancelling/moving one when you are not sure which the user means. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      about: SELECTOR_PROPS.about,
      kind: SELECTOR_PROPS.kind,
      limit: { type: "number", description: "Max to return (default 20)." },
    },
    required: [],
  },
  strict: false,
} as const;

export const CANCEL_REMINDER_TOOL = {
  type: "function",
  name: "cancel_reminder",
  description:
    "Cancel ONE of the user's upcoming reminders or alarms so it never goes off — e.g. 'cancel the 2pm reminder', 'turn off my dentist alarm'. Identify it by reminder_id (best, from list_reminders) or by about / currently_at / on_date / kind. If more than one matches, NOTHING is cancelled and the candidates come back: ask the user which one, never guess. If none matches, say so plainly. Only tell the user it is cancelled AFTER this returns cancelled:true.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { ...SELECTOR_PROPS },
    required: [],
  },
  strict: false,
} as const;

export const MOVE_REMINDER_TOOL = {
  type: "function",
  name: "move_reminder",
  description:
    "Change WHEN one of the user's EXISTING upcoming reminders or alarms goes off — e.g. 'push that alarm to 4', 'move my dentist reminder to tomorrow at 9', 'snooze the 2pm reminder by 30 minutes'. Use this, NOT schedule_reminder, to reschedule one that already exists (schedule_reminder would leave the old one AND add a second). Identify it by reminder_id or about / currently_at / on_date / kind, and give the new time as to_time (+ optional to_date), shift_minutes, or delay_minutes. If more than one matches, NOTHING is moved and the candidates come back: ask the user which one, never guess. Only confirm the new time AFTER this returns moved:true.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...SELECTOR_PROPS,
      to_time: {
        type: "string",
        description: "New local time HH:MM (24-hour), e.g. '16:00' for 'to 4pm'. Without to_date it keeps the reminder's current day (or the next day if that time has already passed).",
      },
      to_date: { type: "string", description: "New local date YYYY-MM-DD, used with to_time." },
      shift_minutes: {
        type: "number",
        description: "Move it this many minutes later (negative = earlier) than its CURRENT time, e.g. 30 for 'push it back half an hour'.",
      },
      delay_minutes: { type: "number", description: "Set it to go off this many minutes from NOW." },
    },
    required: [],
  },
  strict: false,
} as const;

/** One owned reminder row as the management tools see it (the store's shape, decoupled for tests). */
export interface ManagedReminder {
  id: string;
  text: string;
  kind: string;
  due_ms: number;
  status: string;
  task_id: string | null;
}

/** The store the dispatchers talk to. Production = turns.server.ts; tests inject a fake. */
export interface ReminderManageStore {
  list(email: string, opts?: { statuses?: string[]; sinceDueMs?: number; limit?: number }): Promise<ManagedReminder[]>;
  cancel(id: string, email: string): Promise<boolean>;
  move(id: string, email: string, dueAtMs: number): Promise<boolean>;
}

export interface ReminderManageDeps {
  store?: ReminderManageStore;
  /** Owner email resolver. Defaults to schedule_reminder's (resolveTaskEmail ?? entra_email). */
  resolveEmail?: (caller: Caller | undefined) => Promise<string | null>;
  /** Per-turn decision-rights ledger (huddle.functions claimAction). Mutating tools claim
   *  `<tool>:<reminder id>` so two agents in one group turn cannot both cancel/move the same one. */
  claim?: (key: string) => boolean;
  nowMs?: number;
}

async function defaultResolveEmail(caller: Caller | undefined): Promise<string | null> {
  try {
    const { resolveTaskEmail } = await import("../journey/identity");
    return (await resolveTaskEmail(caller as never)) ?? caller?.entra_email ?? null;
  } catch {
    return caller?.entra_email ?? null;
  }
}

async function defaultStore(): Promise<ReminderManageStore> {
  const t = await import("./turns.server");
  return {
    list: (email, opts) => t.listRemindersForOwner(email, opts),
    cancel: (id, email) => t.cancelOwnedReminder(id, email),
    move: (id, email, due) => t.moveOwnedReminder(id, email, due),
  };
}

function localParts(ms: number, tz: string): { y: number; mo: number; d: number; hh: number; mm: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  return { y: +m.year, mo: +m.month, d: +m.day, hh: +m.hour % 24, mm: +m.minute };
}

function safeTz(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local wall-clock (tz) → UTC ms. Two-pass so a DST boundary between guess and answer is handled. */
export function zonedToUtcMs(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let utc = wall - tzOffsetMs(tz, wall);
  utc = wall - tzOffsetMs(tz, utc);
  return utc;
}

/** "HH:MM" in tz. */
export function localClock(ms: number, tz: string): string {
  const p = localParts(ms, safeTz(tz));
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" in tz. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, safeTz(tz));
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Human time in the owner's zone, e.g. "Tue, Nov 3, 2:00 PM". */
export function formatReminderTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz(tz),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Parse a clock the model may send: "14:00", "2:00", "14", "2pm", "2:30 pm". Returns "HH:MM" or null. */
export function parseClock(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ap = m[3];
  if (mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
  } else if (hh > 23) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseIsoDate(raw: unknown): { y: number; mo: number; d: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

const MATCH_STOPWORDS = new Set([
  "the", "a", "an", "my", "to", "for", "about", "of", "at", "on", "in", "that", "this", "it", "me",
  "remind", "reminder", "reminders", "alarm", "alarms", "set", "one",
]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !MATCH_STOPWORDS.has(t));
}

/** The selector words that actually constrain a match (stopwords like "my reminder" do not). */
export function aboutTokens(about: unknown): string[] {
  return typeof about === "string" ? tokens(about) : [];
}

/** True when the args carry at least ONE real constraint. A mutation without one is refused. */
export function hasSelector(args: Record<string, unknown>): boolean {
  const id = typeof args.reminder_id === "string" ? args.reminder_id.trim() : "";
  return (
    !!id ||
    aboutTokens(args.about).length > 0 ||
    parseClock(args.currently_at) != null ||
    parseIsoDate(args.on_date) != null ||
    args.kind === "reminder" ||
    args.kind === "alarm"
  );
}

export type MatchOutcome =
  | { kind: "none"; matches: ManagedReminder[] }
  | { kind: "one"; matches: ManagedReminder[] }
  | { kind: "many"; matches: ManagedReminder[] };

/**
 * Pure matcher. Every given constraint must hold (AND). reminder_id is exact. `about` needs EVERY
 * meaningful word to appear (prefix match per word, so "dentist" finds "dentist's"). Times and dates
 * compare in the OWNER's time zone. Never picks between several: >1 is reported as "many".
 */
export function matchReminders(rows: ManagedReminder[], args: Record<string, unknown>, timeZone: string): MatchOutcome {
  const tz = safeTz(timeZone);
  const id = typeof args.reminder_id === "string" ? args.reminder_id.trim() : "";
  const want = aboutTokens(args.about);
  const at = parseClock(args.currently_at);
  const on = parseIsoDate(args.on_date);
  const onStr = on ? `${on.y}-${String(on.mo).padStart(2, "0")}-${String(on.d).padStart(2, "0")}` : null;
  const kind = args.kind === "reminder" || args.kind === "alarm" ? args.kind : null;

  const hits = rows.filter((r) => {
    if (id && r.id !== id) return false;
    if (kind && r.kind !== kind) return false;
    if (at && localClock(r.due_ms, tz) !== at) return false;
    if (onStr && localDate(r.due_ms, tz) !== onStr) return false;
    if (want.length) {
      const have = tokens(r.text);
      if (!want.every((w) => have.some((h) => h === w || h.startsWith(w)))) return false;
    }
    return true;
  });
  if (hits.length === 0) return { kind: "none", matches: [] };
  if (hits.length === 1) return { kind: "one", matches: hits };
  return { kind: "many", matches: hits };
}

/**
 * Pure: the new fire time for move_reminder, from exactly one of shift_minutes / delay_minutes /
 * to_time(+to_date). Must land in the future.
 */
export function resolveMoveDueMs(
  currentDueMs: number,
  args: Record<string, unknown>,
  timeZone: string,
  nowMs: number,
): { dueMs: number } | { error: string; message: string } {
  const tz = safeTz(timeZone);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
  const shift = num(args.shift_minutes);
  const delay = num(args.delay_minutes);
  const toTime = parseClock(args.to_time);
  const toDate = parseIsoDate(args.to_date);
  const given = [Number.isFinite(shift), Number.isFinite(delay), toTime != null || toDate != null].filter(Boolean).length;
  if (given === 0) {
    return { error: "missing_new_time", message: "Tell me the new time — e.g. to_time '16:00', shift_minutes 30, or delay_minutes 20." };
  }
  if (given > 1) {
    return { error: "conflicting_new_time", message: "Give the new time ONE way: to_time (+to_date), shift_minutes, or delay_minutes." };
  }
  let due: number;
  if (Number.isFinite(shift)) {
    due = currentDueMs + Math.round(shift * 60_000);
  } else if (Number.isFinite(delay)) {
    if (delay <= 0) return { error: "time_in_past", message: "delay_minutes must be more than 0." };
    due = nowMs + Math.round(delay * 60_000);
  } else {
    const cur = localParts(currentDueMs, tz);
    const clock = toTime ?? `${String(cur.hh).padStart(2, "0")}:${String(cur.mm).padStart(2, "0")}`;
    const [hh, mm] = clock.split(":").map(Number);
    const day = toDate ?? { y: cur.y, mo: cur.mo, d: cur.d };
    due = zonedToUtcMs(day.y, day.mo, day.d, hh, mm, tz);
    // Only a time with no explicit date rolls forward; an explicit past date is an error below.
    if (due <= nowMs && !toDate) {
      const now = localParts(nowMs, tz);
      due = zonedToUtcMs(now.y, now.mo, now.d, hh, mm, tz);
      if (due <= nowMs) due = zonedToUtcMs(now.y, now.mo, now.d + 1, hh, mm, tz);
    }
  }
  if (due <= nowMs) {
    return { error: "time_in_past", message: "That new time has already passed — pick a time in the future." };
  }
  return { dueMs: due };
}

function describe(r: ManagedReminder, tz: string, nowMs: number) {
  return {
    id: r.id,
    text: r.text,
    kind: r.kind,
    due_local: formatReminderTime(r.due_ms, tz),
    due_at: new Date(r.due_ms).toISOString(),
    in_minutes: Math.round((r.due_ms - nowMs) / 60_000),
    task_linked: r.task_id != null,
  };
}

const NO_OWNER = JSON.stringify({
  error: "no_owner",
  message: "I couldn't tell whose reminders these are, so I didn't read or change anything.",
});
const NO_SELECTOR = JSON.stringify({
  error: "missing_selector",
  message: "Say which reminder: give reminder_id (from list_reminders), or about / currently_at / on_date / kind.",
});
const RECENT_WINDOW_MS = 7 * 86_400_000;

/** Find the owner's target among PENDING rows; when none, look at recent cancelled/fired ones so the
 *  answer is honest ("already cancelled" / "already went off") instead of a bare "not found". */
async function locate(
  store: ReminderManageStore,
  email: string,
  args: Record<string, unknown>,
  tz: string,
  nowMs: number,
): Promise<{ outcome: MatchOutcome; stale: ManagedReminder[] }> {
  const pending = await store.list(email, { statuses: ["pending"], limit: 200 });
  const outcome = matchReminders(pending, args, tz);
  if (outcome.kind !== "none") return { outcome, stale: [] };
  const recent = await store.list(email, {
    statuses: ["cancelled", "fired"],
    sinceDueMs: nowMs - RECENT_WINDOW_MS,
    limit: 200,
  });
  return { outcome, stale: matchReminders(recent, args, tz).matches };
}

function staleAnswer(tool: "cancel" | "move", stale: ManagedReminder[], tz: string, nowMs: number): string {
  const allCancelled = stale.every((r) => r.status === "cancelled");
  if (tool === "cancel" && allCancelled) {
    // Idempotent: asking to cancel what is already cancelled is a success that changed nothing.
    return JSON.stringify({
      ok: true,
      cancelled: true,
      changed: false,
      already: "cancelled",
      reminders: stale.map((r) => describe(r, tz, nowMs)),
      message: "That reminder was already cancelled — nothing else to do.",
    });
  }
  return JSON.stringify({
    ok: false,
    error: "not_pending",
    changed: false,
    reminders: stale.map((r) => ({ ...describe(r, tz, nowMs), status: r.status })),
    message: allCancelled
      ? "That reminder was cancelled, so there is nothing to move. Offer to set a new one with schedule_reminder."
      : `That reminder has already gone off, so it can't be ${tool === "cancel" ? "cancelled" : "moved"}. Offer to set a new one if they want.`,
  });
}

function ambiguous(matches: ManagedReminder[], tz: string, nowMs: number): string {
  return JSON.stringify({
    ok: false,
    error: "ambiguous",
    changed: false,
    candidates: matches.map((m) => describe(m, tz, nowMs)),
    message: `${matches.length} reminders match that, so I changed nothing. Ask the user which one they mean (list them by text and time), then call again with its reminder_id.`,
  });
}

/** Re-read one id after a mutation that changed nothing, and say what it actually is now. */
async function afterLostRace(
  tool: "cancel" | "move",
  store: ReminderManageStore,
  email: string,
  id: string,
  tz: string,
  nowMs: number,
): Promise<string> {
  const recent = await store.list(email, { statuses: ["cancelled", "fired"], sinceDueMs: nowMs - RECENT_WINDOW_MS, limit: 200 });
  const now = recent.filter((r) => r.id === id);
  if (now.length) return staleAnswer(tool, now, tz, nowMs);
  return JSON.stringify({
    ok: false,
    error: `${tool}_failed`,
    changed: false,
    message: `I couldn't ${tool} it — it may have just changed. Check with list_reminders.`,
  });
}

export async function dispatchListReminders(
  caller: Caller | undefined,
  args: Record<string, unknown>,
  timeZone: string | undefined,
  deps: ReminderManageDeps = {},
): Promise<string> {
  const tz = safeTz(timeZone);
  const nowMs = deps.nowMs ?? Date.now();
  const email = await (deps.resolveEmail ?? defaultResolveEmail)(caller);
  if (!email) return NO_OWNER;
  try {
    const store = deps.store ?? (await defaultStore());
    const rows = await store.list(email, { statuses: ["pending"], limit: 200 });
    const filtered =
      aboutTokens(args.about).length || args.kind === "alarm" || args.kind === "reminder"
        ? matchReminders(rows, { about: args.about, kind: args.kind }, tz).matches
        : rows;
    const limRaw = typeof args.limit === "number" ? args.limit : Number(args.limit);
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(100, Math.round(limRaw)) : 20;
    const shown = filtered.slice(0, limit);
    return JSON.stringify({
      ok: true,
      time_zone: tz,
      count: filtered.length,
      reminders: shown.map((r) => describe(r, tz, nowMs)),
      ...(filtered.length > shown.length ? { truncated: true } : {}),
      message: filtered.length === 0 ? "No upcoming reminders or alarms match." : `${filtered.length} upcoming.`,
    });
  } catch (err) {
    return JSON.stringify({ error: "reminder_read_failed", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function dispatchCancelReminder(
  caller: Caller | undefined,
  args: Record<string, unknown>,
  timeZone: string | undefined,
  deps: ReminderManageDeps = {},
): Promise<string> {
  const tz = safeTz(timeZone);
  const nowMs = deps.nowMs ?? Date.now();
  if (!hasSelector(args)) return NO_SELECTOR;
  const email = await (deps.resolveEmail ?? defaultResolveEmail)(caller);
  if (!email) return NO_OWNER;
  try {
    const store = deps.store ?? (await defaultStore());
    const { outcome, stale } = await locate(store, email, args, tz, nowMs);
    if (outcome.kind === "many") return ambiguous(outcome.matches, tz, nowMs);
    if (outcome.kind === "none") {
      if (stale.length) return staleAnswer("cancel", stale, tz, nowMs);
      return JSON.stringify({
        ok: false,
        error: "no_match",
        changed: false,
        message: "No upcoming reminder or alarm matches that, so nothing was cancelled. Call list_reminders to see what is set.",
      });
    }
    const target = outcome.matches[0];
    if (deps.claim && !deps.claim(`cancel_reminder:${target.id}`)) {
      return JSON.stringify({ ok: true, deduped: true, changed: false, message: "That reminder was already cancelled this turn." });
    }
    if (!(await store.cancel(target.id, email))) return afterLostRace("cancel", store, email, target.id, tz, nowMs);
    return JSON.stringify({
      ok: true,
      cancelled: true,
      changed: true,
      reminder: describe(target, tz, nowMs),
      time_zone: tz,
      message: `Cancelled the ${target.kind} "${target.text}" that was set for ${formatReminderTime(target.due_ms, tz)}.`,
    });
  } catch (err) {
    return JSON.stringify({ error: "reminder_write_failed", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function dispatchMoveReminder(
  caller: Caller | undefined,
  args: Record<string, unknown>,
  timeZone: string | undefined,
  deps: ReminderManageDeps = {},
): Promise<string> {
  const tz = safeTz(timeZone);
  const nowMs = deps.nowMs ?? Date.now();
  if (!hasSelector(args)) return NO_SELECTOR;
  const email = await (deps.resolveEmail ?? defaultResolveEmail)(caller);
  if (!email) return NO_OWNER;
  try {
    const store = deps.store ?? (await defaultStore());
    const { outcome, stale } = await locate(store, email, args, tz, nowMs);
    if (outcome.kind === "many") return ambiguous(outcome.matches, tz, nowMs);
    if (outcome.kind === "none") {
      if (stale.length) return staleAnswer("move", stale, tz, nowMs);
      return JSON.stringify({
        ok: false,
        error: "no_match",
        changed: false,
        message: "No upcoming reminder or alarm matches that, so nothing was moved. Call list_reminders to see what is set.",
      });
    }
    const target = outcome.matches[0];
    const next = resolveMoveDueMs(target.due_ms, args, tz, nowMs);
    if ("error" in next) return JSON.stringify({ ok: false, changed: false, ...next });
    if (Math.abs(next.dueMs - target.due_ms) < 60_000) {
      // Idempotent: already at that time (e.g. a retry of a move that already landed).
      return JSON.stringify({
        ok: true,
        moved: true,
        changed: false,
        reminder: describe(target, tz, nowMs),
        message: `It's already set for ${formatReminderTime(target.due_ms, tz)}.`,
      });
    }
    if (deps.claim && !deps.claim(`move_reminder:${target.id}`)) {
      return JSON.stringify({ ok: true, deduped: true, changed: false, message: "That reminder was already moved this turn." });
    }
    if (!(await store.move(target.id, email, next.dueMs))) return afterLostRace("move", store, email, target.id, tz, nowMs);
    return JSON.stringify({
      ok: true,
      moved: true,
      changed: true,
      reminder: describe({ ...target, due_ms: next.dueMs }, tz, nowMs),
      previous_due_local: formatReminderTime(target.due_ms, tz),
      time_zone: tz,
      message: `Moved the ${target.kind} "${target.text}" from ${formatReminderTime(target.due_ms, tz)} to ${formatReminderTime(next.dueMs, tz)}.`,
    });
  } catch (err) {
    return JSON.stringify({ error: "reminder_write_failed", message: err instanceof Error ? err.message : String(err) });
  }
}
