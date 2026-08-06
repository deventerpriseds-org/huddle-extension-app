// Per-user, per-job-type cadence overrides for the recurring-job scheduler (scheduler.server.ts).
// Mirrors agent-workflow-config.server.ts's pool/bootstrap/whole-object-upsert pattern exactly.
// Exists so cadence values (which hours, which days) are a user-editable Setting, not a hardcoded
// constant only a code change can touch — every job type the scheduler knows about is covered here,
// not just grooming, so the next cadence complaint doesn't need another one-off patch.
import { Pool } from "pg";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE IF NOT EXISTS identity.scheduling_config (
  email      TEXT PRIMARY KEY,
  overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let bootstrapped: Promise<void> | null = null;
async function ensureBootstrapped() {
  if (bootstrapped) return bootstrapped;
  bootstrapped = (async () => {
    await getPool().query(BOOTSTRAP_SQL);
  })();
  try {
    await bootstrapped;
  } catch (e) {
    bootstrapped = null;
    throw e;
  }
}

/** One job type's cadence. daysOfWeek uses Date.getDay() convention: 0=Sun..6=Sat; omitted/empty = every day. */
export interface JobCadence {
  tz: string;
  hours: number[];
  daysOfWeek?: number[];
}

export type JobTypeKey = "groom" | "autowork" | "standup" | "reviewDigest" | "reviewRecheck";

export const DEFAULT_TZ = "America/New_York";

// The actual defaults the app ships with. Grooming defaults to Monday morning only (2026-07-31, per
// the user: it was firing 6x/day and needed cutting back to a weekly check, with the exact time/day
// staying user-editable going forward rather than baked in again).
export const SCHEDULING_DEFAULTS: Record<JobTypeKey, JobCadence> = {
  groom: { tz: DEFAULT_TZ, hours: [8], daysOfWeek: [1] },
  autowork: { tz: DEFAULT_TZ, hours: [9, 13, 17] },
  standup: { tz: DEFAULT_TZ, hours: [8] },
  reviewDigest: { tz: DEFAULT_TZ, hours: [8, 11, 13, 16, 19] },
  reviewRecheck: { tz: DEFAULT_TZ, hours: [10, 16] },
};

export interface SchedulingConfig {
  overrides: Partial<Record<JobTypeKey, JobCadence>>;
}

/**
 * A fan-out window in the user's local tz, as an inclusive-start / exclusive-end hour range.
 * Confirm-intent asks (the auto-work reach-outs that buzz the user's phone) are scheduled at a
 * RANDOM instant inside one of these windows so they arrive spread through the day, never bunched
 * at a single boundary and never outside these hours.
 */
export interface FanWindow {
  start: number; // local hour, inclusive (0–24)
  end: number; // local hour, exclusive (0–24)
}

/**
 * Shipped default fan-out windows for confirm-asks: business hours 9–18 and evening 20–22. The gap
 * (18–20) is a deliberate break so the user isn't pinged over dinner; nothing is scheduled after 22
 * or before 9. Sourced HERE (the one scheduling-config module), not as magic numbers buried in the
 * autowork scheduler — same single-source-of-truth ethos as SCHEDULING_DEFAULTS above.
 */
export const CONFIRM_FAN_WINDOWS_DEFAULT: FanWindow[] = [
  { start: 9, end: 18 },
  { start: 20, end: 22 },
];

/**
 * Resolve the EFFECTIVE confirm-ask fan-out windows for a user. Today returns the shipped default;
 * kept async + email-scoped so a per-user override can be layered in later (mirroring
 * resolveJobCadence) without touching any call site. Never throws.
 */
export async function resolveConfirmFanWindows(_email: string): Promise<FanWindow[]> {
  return CONFIRM_FAN_WINDOWS_DEFAULT;
}

const EMPTY_CONFIG: SchedulingConfig = { overrides: {} };

/** Read the raw stored overrides for an email (empty object when nothing is set). */
export async function getSchedulingConfig(email: string): Promise<SchedulingConfig> {
  await ensureBootstrapped();
  const r = await getPool().query<{ overrides: Partial<Record<JobTypeKey, JobCadence>> }>(
    `SELECT overrides FROM identity.scheduling_config WHERE lower(email) = lower($1)`,
    [email],
  );
  if (r.rowCount === 0) return EMPTY_CONFIG;
  return { overrides: r.rows[0].overrides ?? {} };
}

/** Whole-object upsert, same pattern as agent_workflow_config / artifacts.mirror_config. */
export async function setSchedulingConfig(
  email: string,
  overrides: Partial<Record<JobTypeKey, JobCadence>>,
): Promise<SchedulingConfig> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO identity.scheduling_config (email, overrides, updated_at)
     VALUES ($1,$2::jsonb, now())
     ON CONFLICT (email) DO UPDATE SET overrides = EXCLUDED.overrides, updated_at = now()`,
    [email, JSON.stringify(overrides)],
  );
  return { overrides };
}

/**
 * Resolve the EFFECTIVE cadence for one job type: the user's override if set, else the shipped
 * default. Never throws — a config-read failure falls back to the default cadence (today's existing
 * behavior) rather than blocking the scheduler entirely.
 */
export async function resolveJobCadence(email: string, jobType: JobTypeKey): Promise<JobCadence> {
  try {
    const cfg = await getSchedulingConfig(email);
    return cfg.overrides[jobType] ?? SCHEDULING_DEFAULTS[jobType];
  } catch {
    return SCHEDULING_DEFAULTS[jobType];
  }
}
