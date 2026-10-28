// WHAT:       Delivers one edition of the schedule brief as a proactive push in Iris's 1:1.
// WHY:        The owner asked for the brief to be IRIS's job ("iris should have a task of reminding
//             me 60 minutes before any as well", 2026-10-01), and the schedule/priorities widgets
//             are already docked in her DM — so her thread is where "what's on today" already
//             lives. Splitting build from deliver keeps buildScheduleBrief pure and testable: this
//             file is the only part that writes anything.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:schedule-brief.
//
// EXTENDS THE STANDUP'S DELIVERY PATH, byte for byte where it matters. `standup.server.ts` already
// proved the shape: build a directive, enqueue a DURABLE TURN in the owner agent's DM with
// `notify:"push"` and `internal:true`, then run it. Riding that path means the EXISTING
// away-notification fires (send_push -> Android bridge) with no new sender and no new secret --
// the standing rule in this repo's CLAUDE.md ("piggyback journey, don't build a parallel push").

import type { AgentId } from "../../data/agents";
import { DEFAULT_TZ } from "../identity/scheduling-config.server";
import {
  addDays,
  buildScheduleBrief,
  type BriefEdition,
  type BriefWindow,
  type ScheduleBrief,
} from "./schedule-brief.server";

/** Iris Chase owns this brief — the owner named her, and her DM already carries the docked
 *  schedule + priorities widgets, so "what's on today" is already her thread. */
const BRIEF_OWNER: AgentId = "iris-chase";

/** The button under every brief. Owner, 2026-10-28: the morning check should ask about adjustments
 *  "with deep link ... to each tab" -- the Priorities check already had its button; this is Schedule's.
 *  Attached by the turn runner from the payload (ensureNavLinkDelivered), whatever the model writes. */
export const SCHEDULE_NAV_LINK = { view: "schedule" as const, label: "Open Schedule" };

/** The phone push title, so the 8pm brief no longer reads "Iris Chase replied" exactly like the 8pm
 *  priority check sent one second earlier (push log 2026-10-28T00:00:07Z/08Z). Not sticky: the brief
 *  is a heads-up; the priority check is the one that needs an answer and stays. */
export function scheduleBriefPush(edition: BriefEdition, window?: BriefWindow): { title: string; sticky: false } {
  const title = window
    ? `Iris: rest of your ${window.name.replace(/_/g, " ")} window`
    : edition === "evening"
      ? "Iris: tomorrow's schedule"
      : "Iris: today's schedule";
  return { title, sticky: false };
}

export interface ScheduleBriefResult {
  ok: boolean;
  edition?: BriefEdition;
  forDate?: string;
  /** How many items the edition carried. 0 with ok:true is a legitimate "nothing on". */
  count?: number;
  delivered?: boolean;
  /** Which message shape was (or on a dryRun, would be) sent — see briefDeliveryPlan. */
  kind?: BriefDeliveryKind;
  /** On a dryRun, the exact directive Iris would be handed. */
  directive?: string;
  /** Present on a dryRun, so a verification pass can read exactly what WOULD have been sent. */
  brief?: ScheduleBrief;
  error?: string;
  errors?: string[];
}

/** `"7:00PM"` in the brief's zone. Returns null for an all-day item rather than inventing midnight. */
function clock(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      .replace(/\s?(AM|PM)$/i, (_m, p: string) => p.toUpperCase());
  } catch {
    return null;
  }
}

/**
 * The lines Iris is handed. FACTS ONLY — the model writes the prose around them, but every time,
 * title and location here came from the source, so it has nothing to invent. An item with no start
 * time is labelled "all day" rather than being given a guessed one.
 */
export function briefLines(brief: ScheduleBrief, tz: string): string[] {
  return brief.items.map((i) => {
    const t = clock(i.startIso, tz);
    const end = clock(i.endIso, tz);
    const when = t ? (end ? `${t}–${end}` : t) : "all day";
    const where = i.location ? ` · ${i.location}` : "";
    return `${when} — ${i.title} (${i.kind})${where}`;
  });
}

/**
 * LATER THIS WEEK, grouped under a spoken day label: "tomorrow (Friday, Oct 16)" for the day after
 * a MORNING edition's date, otherwise the weekday. Empty when nothing is on (or nothing was read).
 */
export function upcomingLines(brief: ScheduleBrief, tz: string): string[] {
  const out: string[] = [];
  let last = "";
  for (const i of brief.upcoming ?? []) {
    const day = i.day ?? (i.startIso ? new Date(i.startIso).toISOString().slice(0, 10) : "");
    if (!day) continue;
    if (day !== last) {
      const name = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
      });
      const tomorrow = brief.edition === "morning" && day === addDays(brief.forDate, 1);
      out.push(tomorrow ? `Tomorrow (${name}):` : `${name}:`);
      last = day;
    }
    const t = clock(i.startIso, tz);
    const end = clock(i.endIso, tz);
    const when = t ? (end ? `${t}–${end}` : t) : "all day";
    out.push(`  ${when} — ${i.title} (${i.kind})${i.location ? ` · ${i.location}` : ""}`);
  }
  return out;
}

export type BriefDeliveryKind = "items" | "read-error" | "nothing-scheduled";

/**
 * Decide WHAT Iris is told for an edition. PURE, so the three outcomes are unit-testable.
 *
 * EVERY EDITION NOW SENDS SOMETHING (owner-directed 2026-10-15). It used to be "nothing on = nothing
 * sent", and the same `!items.length` return also swallowed an edition whose sources FAILED — so a
 * broken calendar read (wrong mailbox, see meetingsForDate) was indistinguishable from an empty day
 * and the brief was silent for ten days with nobody able to tell why. Now:
 *   items              -> the normal brief (with an "incomplete" note if one source failed)
 *   no items + errors  -> a short notice that the calendar could NOT be read, with the error text
 *   no items, no errors-> a short "nothing on your calendar" message — the owner wants one every
 *                         morning and evening so silence never has to be interpreted.
 */
export function briefDeliveryPlan(
  brief: ScheduleBrief,
  tz: string,
): { kind: BriefDeliveryKind; directive: string } {
  // A WINDOW message (owner, 2026-10-15: "...and for each window as they pop up") covers only what
  // is still ahead in that window; the day/evening editions cover the whole day.
  const w = brief.window;
  const hr = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
  const winName = w ? `${w.name.replace(/_/g, " ")} window (${hr(w.start)}–${hr(w.end)})` : "";
  const day = w
    ? `Today (${brief.forDate}), the ${winName} — what is still ahead`
    : brief.edition === "evening"
      ? `Tomorrow (${brief.forDate})`
      : `Today (${brief.forDate})`;
  // TASKS (owner: "i have tasks everyday and i do want a similar message"). Listed separately from
  // meetings/classes, and named after them, so neither is lost in the other.
  const taskLines = (brief.tasks ?? []).map(
    (t) => `${clock(t.startIso, tz) ?? "any time"} — ${t.title} (task)`,
  );
  const taskBlock =
    brief.tasks !== undefined
      ? `\nTASKS:\n${taskLines.length ? taskLines.join("\n") : "(no tasks scheduled)"}`
      : brief.tasksError
        ? `\nTASKS: could not be read (${brief.tasksError}) — say so; do not claim there are none.`
        : "";
  const hasAny = brief.items.length > 0 || taskLines.length > 0;
  // Owner, 2026-10-15: "Why didn't iris say something like, hello Sir, just a reminder that today you
  // have x and y, and later in the week you have a tomorrow, b the next day etc etc?" The old
  // directive asked for "ONE short heads-up ... lead with the first thing", and the brief only ever
  // read ONE day, so there was no week to mention. Both are fixed here and in buildScheduleBrief.
  const week = w ? [] : upcomingLines(brief, tz);
  const weekBlock = w ? "" :
    `LATER THIS WEEK:\n${week.length ? week.join("\n") : "(nothing scheduled)"}` +
    (brief.upcomingErrors?.length ? `\n(lookahead partly unread: ${brief.upcomingErrors.join("; ")})` : "");
  const when = w ? `for the rest of the ${winName}` : brief.edition === "evening" ? "tomorrow" : "today";
  const tasksAsk = taskLines.length
    ? `After a blank line, write "On your task list:" and then each TASK on its OWN line as ` +
      `"• <time> — <title>", earliest first. `
    : brief.tasks !== undefined
      ? `There are no tasks scheduled ${when}; say so in a few words. `
      : "";
  // Owner, 2026-10-28: "the formatting in the thread is all smashed together not clean". This used to
  // demand ONE message of natural sentences with NO bullet points, so eleven tasks became one run-on
  // sentence. The chat shows the text as-is (whitespace-pre-wrap, no markdown), so line breaks ARE the
  // layout. The spoken "Hello Sir, just a reminder that ..." opening (owner, 2026-10-15) is kept.
  const spoken =
    `Write it in your own warm voice, laid out as SEPARATE SHORT LINES, never one long sentence: put ` +
    `each meeting, class, task and later-in-the-week item on its OWN line starting "• ", with a blank ` +
    `line between sections. Use plain text only (real line breaks, "• " for items, no ** or # or other ` +
    `markdown). `;
  const weekAsk = week.length
    ? `After a blank line, write "Later this week:" and then each LATER THIS WEEK item on its OWN line ` +
      `as "• <day>, <time> — <item>" (say "Tomorrow" where it is labelled Tomorrow, otherwise the ` +
      `weekday). `
    : w
      ? ``
      : `There is nothing later in the week, so do not mention the rest of the week. `;
  // Owner, 2026-10-28: he wants the morning (and the evening look at tomorrow) to ASK whether anything
  // needs adjusting, with the button to the Schedule tab (attached from the payload's navLink). A window
  // message is a mid-day heads-up, so it carries the button but no question.
  const adjustAsk = w
    ? ``
    : `End with a blank line and ONE short line asking whether he wants to adjust anything ` +
      `${brief.edition === "evening" ? "for tomorrow" : "today"}, saying the "${SCHEDULE_NAV_LINK.label}" ` +
      `button below takes him to the Schedule tab. `;
  const reportOnly =
    `This is a REPORT-ONLY turn — everything above is already known, so do NOT call any tool, do not ` +
    `invent anything that is not listed, and do not paste raw JSON. Keep it skimmable.`;

  if (!hasAny && brief.errors.length) {
    // Name ONLY the sources that failed. Owner, 2026-10-15: Iris said she "couldn't pull the meetings
    // and classes" when only classes had failed (classes: http_500) and the meetings read had worked
    // -- blaming both sent the diagnosis to the wrong place. An error with no recognised source prefix
    // (e.g. a programme-lookup failure) counts against classes, which is the read it blocks.
    const failed = new Set<string>();
    for (const e of brief.errors) {
      const src = e.split(":")[0].trim().toLowerCase();
      failed.add(src === "meetings" ? "meetings" : "classes");
    }
    const failedNames = (["meetings", "classes"] as const).filter((s) => failed.has(s));
    const readFine = (["meetings", "classes"] as const).filter((s) => !failed.has(s));
    const when = brief.edition === "evening" ? "tomorrow's" : "today's";
    return {
      kind: "read-error",
      directive:
        `${day} — the schedule brief could NOT read: ${failedNames.join(" and ")}.${taskBlock}\n` +
        `Errors: ${brief.errors.join("; ")}\n` +
        (readFine.length
          ? `${readFine.join(" and ")} WERE read successfully and nothing is scheduled there.\n\n`
          : `\n`) +
        `Write ONE short message in your own voice telling the user you couldn't pull ${when} ` +
        `${failedNames.join(" and ")}, quote the error text above briefly so it can be fixed` +
        (readFine.length ? `, and say ${readFine.join(" and ")} came back clear` : ``) +
        `. Do NOT say or imply the ${failedNames.join(" or ")} ${failedNames.length > 1 ? "are" : "is"} empty — you do not know that. ` +
        reportOnly,
    };
  }

  if (!hasAny) {
    return {
      kind: "nothing-scheduled",
      directive:
        `${day} — nothing is on the calendar: no meetings and no classes were found.${taskBlock}\n${weekBlock}\n\n` +
        spoken +
        `Open with "Hello Sir," and say there is nothing on the calendar ${when}` +
        (brief.tasks !== undefined ? ` and no tasks scheduled` : ``) + `. ` +
        (week.length
          ? `Then, after a blank line, write "Later this week:" and each LATER THIS WEEK item on its OWN ` +
            `line as "• <day>, <time> — <item>" (say "Tomorrow" where it is labelled Tomorrow, otherwise ` +
            `the weekday). `
          : `Keep it to one or two sentences. `) +
        adjustAsk +
        reportOnly,
    };
  }

  const lines = briefLines(brief, tz);
  return {
    kind: "items",
    directive:
      `${day} — here is what is on:\n${lines.length ? lines.join("\n") : "(no meetings or classes)"}${taskBlock}\n${weekBlock}\n\n` +
      spoken +
      `Open with "Hello Sir," then say "just a reminder that ${when} you have …", then the ` +
      `meetings and classes listed, earliest first, each on its OWN line as "• <time> — <name>" (if there ` +
      `are none, finish the opening line with "no meetings or classes."). Mention a location only when one ` +
      `is given. ` +
      tasksAsk +
      weekAsk +
      adjustAsk +
      `${brief.errors.length ? `Say plainly that one source could not be read (${brief.errors.join("; ")}), so this may be incomplete. ` : ""}` +
      reportOnly,
  };
}

/** A `runId` that marks a DELIBERATE manual re-run (run-schedule-brief.yml sends `manual-<utc ts>`).
 *  Only this shape may make a fresh brief turn; see scheduleBriefTurnId. */
const MANUAL_RERUN_ID = /^manual-[A-Za-z0-9_-]{1,64}$/;

/**
 * THE idempotency key for one brief turn: (owner, slot, local date it covers). Every producer of a
 * brief -- Huddle's own scheduler and journey's window trigger -- goes through runScheduleBrief, and
 * runScheduleBrief derives its turn id ONLY here, so two producers asking for the same brief land on
 * the same `chat.pending_turns` id and `enqueueTurn`'s `ON CONFLICT (id) DO NOTHING` makes the
 * second one a no-op: one turn, one push, whichever fires first.
 *
 * `runId` is IGNORED unless it is a manual re-run id. The scheduler's `fireJob` sends every job a
 * generic per-slot runId (`<job id>-<YYYYMMDDHH>`) as a retry guard for jobs with no natural key.
 * The brief HAS a natural key, and appending that runId is exactly what split Huddle's 8am brief
 * (`schedule-brief-morning-<date>-schedule-brief-u-<uuid>-<date>08`) from journey's
 * (`schedule-brief-morning-<date>`) -- two 8am messages every weekday 2026-10-16..27
 * (docs/qc-evidence/FIX-iris-morning-dedupe.md).
 *
 * `owner` is the resolved user id when there is one (one person, many sign-in emails = one owner,
 * the same rule as scheduler.server.ts `scheduledJobId`), else the lower-cased login email.
 */
export function scheduleBriefTurnId(k: {
  slot: string;
  forDate: string;
  owner: { userId: string | null; email: string };
  runId?: string;
}): string {
  const owner = k.owner.userId ? `u-${k.owner.userId}` : `e-${k.owner.email.trim().toLowerCase()}`;
  const rerun = k.runId && MANUAL_RERUN_ID.test(k.runId) ? `-${k.runId}` : "";
  return `schedule-brief-${k.slot}-${k.forDate}-${owner}${rerun}`;
}

/**
 * Run one edition for one user and deliver it.
 *
 * NEVER THROWS — every failure is a normal `ok:false` return, matching every other scheduled job
 * here. A scheduler that throws loses the whole tick for every other job claimed in it.
 */
export async function runScheduleBrief(
  caller: { entra_email: string },
  opts: {
    timeZone?: string;
    edition?: BriefEdition;
    dryRun?: boolean;
    runId?: string;
    /** Injectable clock, so a test pins the edition instead of waiting for 8pm. */
    nowMs?: number;
    /** A journey WINDOW message (sent when journey's window call fires): what is still ahead in it. */
    window?: BriefWindow;
  } = {},
): Promise<ScheduleBriefResult> {
  const tz = opts.timeZone?.trim() || DEFAULT_TZ;
  const nowMs = opts.nowMs ?? Date.now();

  // The calendar lives in the OWNER's canonical mailbox, which is not necessarily the login the
  // scheduler posts (the job targets dev@, the meetings live under the resolved identity). Resolve it
  // EXACTLY the way the working `get_external_calendar_events` agent tool does, so the brief and the
  // tool can never read two different calendars again.
  let mailbox = caller.entra_email;
  try {
    // resolveCalendarMailbox = journey's connected Outlook account (Von.Ellis@), not the data-scope
    // email (dev@) -- reading dev@ found 0 meetings with no error on 2026-10-15.
    const { resolveCalendarMailbox } = await import("../journey/identity");
    mailbox = (await resolveCalendarMailbox(caller)) ?? caller.entra_email;
  } catch {
    /* identity lookup is best-effort — fall back to the login rather than to the sending mailbox */
  }

  let brief: ScheduleBrief;
  try {
    brief = await buildScheduleBrief({
      nowMs,
      cadence: { tz },
      edition: opts.window ? "morning" : opts.edition, // a window is always TODAY
      mailbox,
      // The task mirror is keyed by the login email; getScheduledTasksBetween widens to every alias.
      taskEmail: caller.entra_email,
      window: opts.window,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "brief build failed" };
  }

  const base: ScheduleBriefResult = {
    ok: brief.ok,
    edition: brief.edition,
    forDate: brief.forDate,
    count: brief.items.length,
    ...(brief.errors.length ? { errors: brief.errors } : {}),
  };

  const plan = briefDeliveryPlan(brief, tz);
  if (opts.dryRun)
    return { ...base, delivered: false, kind: plan.kind, directive: plan.directive, brief };
  const directive = plan.directive;

  // The run id is keyed on the OWNER, the EDITION AND THE DATE IT COVERS, not on a timestamp or on
  // which producer asked: a scheduler retry, an overlapping tick, AND journey's 8am window call all
  // land on the same id, `enqueueTurn` returns not-fresh, and the owner gets ONE push.
  // A window gets its own key per day, so 11am/5pm/7pm each send once. journey's 8am MORNING window is
  // sent WITHOUT a window (as the morning edition), so it shares this key with Huddle's own 8am brief
  // and the owner gets ONE 8am message whichever fires first. See scheduleBriefTurnId for why the
  // scheduler's runId is NOT part of the key.
  const slot = opts.window ? `window-${opts.window.name}` : brief.edition;
  let owner: { userId: string | null; email: string } = { userId: null, email: caller.entra_email };
  try {
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    owner = {
      userId: (await resolveScopeByEmail(caller.entra_email)).userId,
      email: caller.entra_email,
    };
  } catch {
    /* identity lookup is best-effort — the email still keys one owner */
  }
  const turnId = scheduleBriefTurnId({ slot, forDate: brief.forDate, owner, runId: opts.runId });

  const payload = {
    text: directive,
    huddleId: `dm-${BRIEF_OWNER}`,
    scope: "one-to-one",
    members: [BRIEF_OWNER],
    targetAgentId: BRIEF_OWNER,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [BRIEF_OWNER]: { backend: "openai", journey: { enabled: false } } },
    timeZone: tz,
    caller,
    notify: "push", // this IS the alert — the whole point is that it reaches the phone
    internal: true, // system-originated digest — never pass along / defer
    navLink: SCHEDULE_NAV_LINK,
    pushStyle: scheduleBriefPush(brief.edition, opts.window),
  };

  try {
    const { enqueueTurn } = await import("./turns.server");
    const fresh = await enqueueTurn(turnId, `dm-${BRIEF_OWNER}`, caller.entra_email, payload);
    if (fresh) {
      const { runTurnById } = await import("../huddle.functions");
      await runTurnById(turnId);
    }
    return { ...base, kind: plan.kind, delivered: !!fresh };
  } catch (err) {
    return {
      ...base,
      ok: false,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
