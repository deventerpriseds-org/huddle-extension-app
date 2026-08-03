// General recurring-job dispatcher, resident in the Huddle app + Azure Huddle PG (NOT supabase). It is
// driven by the SAME every-minute heartbeat that already drains durable turns and fires reminders (the
// run-turn route journey's pg_cron pokes). Each tick it: (1) makes sure every user with an open backlog
// has an auto-groom job, then (2) claims all DUE jobs and fires each in its own request (fire-and-forget
// self-POST, like kickNextChunk) so heavy work never blocks the tick. Adding a new recurring job type =
// one case in fireJob + a row — no new cron, no new secret. next_run_at is DST-correct (evaluated in the
// job's IANA tz), so fixed local times (e.g. 4/8/12/14/18/22 ET) hold year-round.

import {
  claimDueScheduledJobs,
  getUsersWithOpenBacklog,
  setScheduledJobNextRun,
  upsertScheduledJob,
  type ScheduledJob,
} from "./tasks.server";
import { resolveJobCadence, DEFAULT_TZ, type JobCadence, type JobTypeKey } from "../identity/scheduling-config.server";

// Cadences (which hours, which days) are a user-editable Setting (Settings → Account → Scheduling),
// not a hardcoded constant — see scheduling-config.server.ts. SCHEDULING_DEFAULTS there is what a
// brand-new user starts with; resolveJobCadence() is what actually runs, per-user, live.

/** ms to add to a UTC instant so that formatting it in `tz` yields the same wall-clock — i.e. tz offset. */
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** The UTC instant for local wall-clock `hour`:00 on a given local Y/M/D in `tz` (DST-correct). */
function localWallToUtc(tz: string, year: number, month1: number, day: number, hour: number): Date {
  const guess = Date.UTC(year, month1 - 1, day, hour, 0, 0);
  // Correct the guess by the tz offset in effect at that instant (good enough; DST-boundary hours are
  // not in our schedule and a 1h edge slip is harmless given the change-gate).
  return new Date(guess - tzOffsetMs(tz, new Date(guess)));
}

/** Next UTC instant strictly after `from` whose local (tz) time is one of `hours`:00, optionally
 * restricted to specific local weekdays (`daysOfWeek`, Date.getDay() convention: 0=Sun..6=Sat;
 * omitted/empty = every day). Scans a full 8-day window so a single-day-of-week cadence (e.g.
 * "Monday only") always finds its next occurrence, not just a 3-day lookahead built for daily use. */
export function computeNextRun(hours: number[], tz: string, from: Date, daysOfWeek?: number[]): Date {
  const slots = [...new Set(hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  if (!slots.length) return new Date(from.getTime() + 3_600_000);
  const dayFilter = daysOfWeek && daysOfWeek.length ? new Set(daysOfWeek) : null;
  // Anchor on the local calendar day of `from`, scan today + next 7 days (a full week, so a
  // single-weekday cadence is guaranteed to find its next slot) for the first future match.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(from);
  const lp = Object.fromEntries(local.map((x) => [x.type, x.value])) as Record<string, string>;
  let y = +lp.year;
  let m = +lp.month;
  let d = +lp.day;
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const localNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const localDow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(localNoon);
    const dowIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(localDow);
    if (!dayFilter || dayFilter.has(dowIndex)) {
      for (const h of slots) {
        const cand = localWallToUtc(tz, y, m, d, h);
        if (cand.getTime() > from.getTime()) return cand;
      }
    }
    // advance one local day
    const next = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return new Date(from.getTime() + 3_600_000);
}

/** One row description: the job-type key scheduling-config.server.ts knows it by, the id prefix,
 * and the job_type string stored on the row / matched in fireJob. Adding a new recurring job type is
 * one more entry here + a default in SCHEDULING_DEFAULTS + one more `fireJob` case — no new cron. */
const JOB_ROWS: { key: JobTypeKey; idPrefix: string; jobType: string }[] = [
  { key: "groom", idPrefix: "groom", jobType: "groom" },
  { key: "autowork", idPrefix: "autowork", jobType: "auto-work" },
  { key: "standup", idPrefix: "standup", jobType: "standup-digest" },
  { key: "reviewDigest", idPrefix: "review-digest", jobType: "review-digest" },
  { key: "reviewRecheck", idPrefix: "review-recheck", jobType: "review-recheck" },
];

/**
 * Ensure every user with an open backlog has a row for every job type in JOB_ROWS (idempotent; only
 * new rows get a next_run seeded — an existing row's next_run_at is left alone so a pending fire
 * isn't disturbed, but `cadence` DOES refresh every tick, so a live Settings change to hours/days
 * takes effect on that job's next fire without needing to delete/recreate anything).
 */
async function ensureGroomJobs(now: Date): Promise<void> {
  const emails = await getUsersWithOpenBacklog();
  for (const email of emails) {
    for (const row of JOB_ROWS) {
      const cadence: JobCadence = await resolveJobCadence(email, row.key);
      await upsertScheduledJob({
        id: `${row.idPrefix}-${email}`,
        jobType: row.jobType,
        targetEmail: email,
        cadence,
        nextRunAt: computeNextRun(cadence.hours, cadence.tz, now, cadence.daysOfWeek).toISOString(),
        meta: {},
      });
    }
  }
}

/** Self-POST base URL + shared token, mirroring kickNextChunk. */
function selfBase(): string {
  const raw =
    (process.env.HUDDLE_APP_URL ?? "").trim() ||
    (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : "");
  return raw.replace(/\/$/, "");
}

/** Fire one due job in its OWN request (fire-and-forget) so heavy work never blocks the heartbeat tick. */
async function fireJob(job: ScheduledJob, slotId: string): Promise<void> {
  const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  const base = selfBase();
  if (!token || !base) return;
  const body = JSON.stringify({
    caller: { entra_email: job.target_email },
    timeZone: job.cadence?.tz ?? DEFAULT_TZ,
    runId: slotId,
  });
  const post = (path: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": token },
      body,
    }).catch(() => {});
  if (job.job_type === "groom") {
    // No force: a cadence fire respects the change-gate (an unchanged backlog is skipped).
    await post("/api/public/run-grooming");
  } else if (job.job_type === "auto-work") {
    // No force: a cadence fire is a no-op when there's nothing new to research.
    await post("/api/public/run-autowork");
  } else if (job.job_type === "standup-digest") {
    // No force: a cadence fire is a no-op when nothing happened and nothing is blocked.
    await post("/api/public/run-standup");
  } else if (job.job_type === "review-digest") {
    // No force: a cadence fire is a no-op when nothing is waiting in review.
    await post("/api/public/run-review-digest");
  } else if (job.job_type === "review-recheck") {
    // No force: a cadence fire is a no-op when no IN_REVIEW task's 48h ping is due yet.
    await post("/api/public/run-review-recheck");
  }
  // Future: else if (job.job_type === "ceremony") { ... POST run-ceremony ... }
}

/**
 * One heartbeat tick of the scheduler: register groom jobs for active users, claim every due job, set
 * each job's next fire time, and fire it decoupled. Returns how many jobs were dispatched. Safe to call
 * every minute — idle ticks are one small indexed query.
 */
export async function runDueScheduledJobs(): Promise<number> {
  const now = new Date();
  try {
    await ensureGroomJobs(now);
  } catch {
    /* best-effort registration — never fail the tick on it */
  }
  let claimed: ScheduledJob[] = [];
  try {
    claimed = await claimDueScheduledJobs(20);
  } catch {
    return 0;
  }
  let fired = 0;
  for (const job of claimed) {
    const tz = job.cadence?.tz ?? DEFAULT_TZ;
    const hours = job.cadence?.hours?.length ? job.cadence.hours : [8];
    const daysOfWeek = job.cadence?.daysOfWeek;
    // Advance to the real next slot (claim held it ~90s; overwrite with the true next fire time).
    try {
      await setScheduledJobNextRun(job.id, computeNextRun(hours, tz, now, daysOfWeek).toISOString());
    } catch {
      /* if this fails the 90s hold retries the job later — idempotent slot id prevents a double run */
    }
    // Stable per-slot id (local hour bucket) so a retry within the same slot can't double-fire the job.
    const slotKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    })
      .format(now)
      .replace(/[^0-9]/g, "");
    void fireJob(job, `${job.id}-${slotKey}`);
    fired++;
  }
  return fired;
}
