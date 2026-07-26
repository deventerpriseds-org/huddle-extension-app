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

// Default auto-groom cadence: six local checks a day (a fresh groom only fires if the backlog actually
// changed — the run-grooming change-gate handles that; here we just decide WHEN to check).
const DEFAULT_GROOM_HOURS = [4, 8, 12, 14, 18, 22];
// Auto-work runs less often than grooming (it does live web research + artifact writes). It fires
// AFTER grooming has assigned/triaged, so agents pick up freshly-assigned work.
const DEFAULT_AUTOWORK_HOURS = [9, 13, 17];
const DEFAULT_TZ = "America/New_York";

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

/** Next UTC instant strictly after `from` whose local (tz) time is one of `hours`:00. */
export function computeNextRun(hours: number[], tz: string, from: Date): Date {
  const slots = [...new Set(hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  if (!slots.length) return new Date(from.getTime() + 3_600_000);
  // Anchor on the local calendar day of `from`, scan today + next 2 days for the first future slot.
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
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    for (const h of slots) {
      const cand = localWallToUtc(tz, y, m, d, h);
      if (cand.getTime() > from.getTime()) return cand;
    }
    // advance one local day
    const next = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return new Date(from.getTime() + 3_600_000);
}

/**
 * Ensure every user with an open backlog has an auto-groom job AND an auto-work job (idempotent; only new
 * rows get a next_run — a conflict never overwrites the claimed watermark). Adding a recurring job type is
 * one more row here + one more `fireJob` case.
 */
async function ensureGroomJobs(now: Date): Promise<void> {
  const emails = await getUsersWithOpenBacklog();
  for (const email of emails) {
    const groom = { tz: DEFAULT_TZ, hours: DEFAULT_GROOM_HOURS };
    await upsertScheduledJob({
      id: `groom-${email}`,
      jobType: "groom",
      targetEmail: email,
      cadence: groom,
      // On first insert this seeds the next fire; on conflict it's ignored (next_run_at not overwritten).
      nextRunAt: computeNextRun(groom.hours, groom.tz, now).toISOString(),
      meta: {},
    });
    const autowork = { tz: DEFAULT_TZ, hours: DEFAULT_AUTOWORK_HOURS };
    await upsertScheduledJob({
      id: `autowork-${email}`,
      jobType: "auto-work",
      targetEmail: email,
      cadence: autowork,
      nextRunAt: computeNextRun(autowork.hours, autowork.tz, now).toISOString(),
      meta: {},
    });
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
    const hours = job.cadence?.hours ?? DEFAULT_GROOM_HOURS;
    // Advance to the real next slot (claim held it ~90s; overwrite with the true next fire time).
    try {
      await setScheduledJobNextRun(job.id, computeNextRun(hours, tz, now).toISOString());
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
