// Azure-PG mirror of journey's `tasks`, kept in sync by a supabase pg_net trigger that POSTs
// to /api/public/tasks-sync on every add/edit/delete. This makes prioritization
// supabase-independent: the scorer reads from here, not from journey at request time.
// Auto-bootstraps its schema on first use (same pattern as identity/identity.server.ts).
import { Pool } from "pg";
import type { ScorableTask } from "./scoring";

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

// Enums stored as TEXT (journey extends its enums with ALTER TYPE ADD VALUE, which can't be
// mirrored transactionally — text avoids the coupling). user_email is the join key Huddle
// filters on (resolved from journey's profiles/user_email_aliases in the sync payload).
const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS tasks;

CREATE TABLE IF NOT EXISTS tasks.journey_tasks (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  user_email     TEXT,
  title          TEXT NOT NULL,
  description    TEXT,
  status         TEXT,
  priority       TEXT NOT NULL DEFAULT 'MEDIUM',
  category       TEXT,
  is_priority    BOOLEAN NOT NULL DEFAULT false,
  priority_rank  INTEGER,
  due_date       TIMESTAMPTZ,
  start_time     TIMESTAMPTZ,
  end_time       TIMESTAMPTZ,
  is_scheduled   BOOLEAN NOT NULL DEFAULT false,
  pushed_count   INTEGER NOT NULL DEFAULT 0,
  board_id       TEXT,
  completed_at   TIMESTAMPTZ,
  assigned_agent TEXT,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Grooming fields synced back from journey (added after the table first shipped).
ALTER TABLE tasks.journey_tasks ADD COLUMN IF NOT EXISTS assigned_agent TEXT;
ALTER TABLE tasks.journey_tasks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS journey_tasks_user_email_idx ON tasks.journey_tasks (lower(user_email));
CREATE INDEX IF NOT EXISTS journey_tasks_category_idx   ON tasks.journey_tasks (category);
CREATE INDEX IF NOT EXISTS journey_tasks_assigned_idx   ON tasks.journey_tasks (assigned_agent);

-- Persisted scrum-ceremony runs (stand-up/retro/planning/review), so an auto-run or a
-- past run is reviewable later as a thread. transcript = the ordered agent turns.
CREATE TABLE IF NOT EXISTS tasks.ceremony_runs (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL,
  ceremony_type TEXT NOT NULL,
  mode         TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',
  summary      TEXT,
  transcript   JSONB NOT NULL DEFAULT '[]',
  auto_run     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ceremony_runs_user_idx ON tasks.ceremony_runs (lower(user_email), created_at DESC);

-- Change-detection watermark for AUTO backlog grooming. The cadence runner grooms only when the
-- backlog's grooming-INDEPENDENT shape changed since the last groom (see backlogSignature): the
-- signature is a hash over open tasks' id/title/status/due_date — NOT the assigned_agent/tags/
-- priority/rank that grooming itself writes — so a re-groom of an unchanged backlog is a no-op and
-- never re-fires. One row per user.
CREATE TABLE IF NOT EXISTS tasks.groom_state (
  user_email      TEXT PRIMARY KEY,
  signature       TEXT,
  last_groomed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Change-detection watermark for ACT-5 auto-work (agents self-starting research on assigned tasks).
-- Same idea as groom_state: skip a pass when the open-assigned backlog hasn't changed since last run.
CREATE TABLE IF NOT EXISTS tasks.autowork_state (
  user_email     TEXT PRIMARY KEY,
  signature      TEXT,
  last_worked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent-discovered blockers (ACT-5). "Blocked" is NOT guessed by grooming from a title + a hand-written
-- capability list any more — it is EARNED: when an agent actually works a task and genuinely can't
-- advance it, it records the specific real reason here (and sets the journey task status=BLOCKED, which
-- syncs to the mirror). The standup/surfacing reads this to show WHY, in the agent's own words. Keyed by
-- the journey task id. This is Huddle-native (the mirror is single-writer — only the sync trigger writes
-- tasks.journey_tasks — so the reason lives in its own table, not on the mirror row).
CREATE TABLE IF NOT EXISTS tasks.task_blockers (
  task_id     TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  agent_id    TEXT,
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_blockers_user_idx ON tasks.task_blockers (lower(user_email));

-- GENERAL recurring-job scheduler, resident in Azure Huddle PG (NOT supabase). One heartbeat — the
-- existing every-minute run-turn tick — dispatches every due job here, so any recurring/scheduled job
-- (grooming today; ceremonies/digests next) is just a row: no new cron, no new secret. cadence holds
-- the local-time spec ({tz, hours:[...]}); next_run_at is the claimed watermark (advanced after each
-- fire, DST-evaluated in the dispatcher). Claiming pushes next_run_at ~90s out so a second concurrent
-- tick can't double-fire before the real next slot is computed.
CREATE TABLE IF NOT EXISTS tasks.scheduled_jobs (
  id           TEXT PRIMARY KEY,
  job_type     TEXT NOT NULL,
  target_email TEXT NOT NULL,
  cadence      JSONB NOT NULL DEFAULT '{}',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  meta         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON tasks.scheduled_jobs (enabled, next_run_at);

-- The scrum master's editable "capability prompt": what the app CAN and CANNOT do today, so the
-- grooming router only assigns work agents can actually execute (e.g. no payments until Plaid).
CREATE TABLE IF NOT EXISTS tasks.router_config (
  user_email        TEXT PRIMARY KEY,
  capability_prompt TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// NOTE: the hand-written "capability prompt" was removed. Capability is DATA — the tools each agent is
// actually wired with — not a prose paragraph that drifts and gets guessed against a task title. Grooming
// no longer classifies "blocked"; the owning agent earns that verdict by working the task (flag_blocker),
// recording the real reason in tasks.task_blockers. See setTaskBlocker / clearTaskBlocker below.

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

/** A row as it arrives from the journey sync payload (journey's `tasks` columns). */
export interface JourneyTaskPayload {
  id: string;
  user_id?: string | null;
  user_email?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  category?: string | null;
  is_priority?: boolean | null;
  priority_rank?: number | null;
  due_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  is_scheduled?: boolean | null;
  pushed_count?: number | null;
  board_id?: string | null;
  completed_at?: string | null;
  assigned_agent?: string | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export async function upsertJourneyTask(row: JourneyTaskPayload, userEmail?: string | null): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.journey_tasks
       (id,user_id,user_email,title,description,status,priority,category,is_priority,priority_rank,
        due_date,start_time,end_time,is_scheduled,pushed_count,board_id,completed_at,assigned_agent,tags,created_at,updated_at,synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'MEDIUM'),$8,COALESCE($9,false),$10,
             $11,$12,$13,COALESCE($14,false),COALESCE($15,0),$16,$17,$18,COALESCE($19::text[],'{}'::text[]),COALESCE($20,now()),COALESCE($21,now()),now())
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id, user_email=EXCLUDED.user_email, title=EXCLUDED.title,
       description=EXCLUDED.description, status=EXCLUDED.status, priority=EXCLUDED.priority,
       category=EXCLUDED.category, is_priority=EXCLUDED.is_priority, priority_rank=EXCLUDED.priority_rank,
       due_date=EXCLUDED.due_date, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
       is_scheduled=EXCLUDED.is_scheduled, pushed_count=EXCLUDED.pushed_count, board_id=EXCLUDED.board_id,
       completed_at=EXCLUDED.completed_at, assigned_agent=EXCLUDED.assigned_agent, tags=EXCLUDED.tags,
       updated_at=EXCLUDED.updated_at, synced_at=now()`,
    [
      row.id, row.user_id ?? null, userEmail ?? row.user_email ?? null, row.title, row.description ?? null,
      row.status ?? null, row.priority ?? null, row.category ?? null, row.is_priority ?? null, row.priority_rank ?? null,
      row.due_date ?? null, row.start_time ?? null, row.end_time ?? null, row.is_scheduled ?? null,
      row.pushed_count ?? null, row.board_id ?? null, row.completed_at ?? null, row.assigned_agent ?? null,
      row.tags ?? null, row.created_at ?? null, row.updated_at ?? null,
    ],
  );
}

export async function deleteJourneyTask(id: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(`DELETE FROM tasks.journey_tasks WHERE id = $1`, [id]);
}

/** A task row shaped for the stand-up report (keeps done/blocked, unlike the scorer feed). */
export interface StandupTask {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  category: string | null;
  is_priority: boolean | null;
  due_date: string | null;
  pushed_count: number | null;
  completed_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  assigned_agent: string | null;
  tags: string[] | null;
}

/**
 * Tasks for a stand-up: every OPEN task (including blocked) plus tasks COMPLETED within
 * the recent window (so "what got done" has a horizon). Unlike getTasksForUser this does
 * NOT drop DONE/BLOCKED — the ceremony needs both progress and blockers.
 */
export async function getStandupTasks(userEmail: string, windowHours = 36): Promise<StandupTask[]> {
  await ensureBootstrapped();
  const hrs = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(windowHours, 24 * 14) : 36;
  const { rows } = await getPool().query<StandupTask>(
    `SELECT id,title,status,priority,category,is_priority,due_date,pushed_count,completed_at,updated_at,created_at,assigned_agent,tags
       FROM tasks.journey_tasks
      WHERE lower(user_email) = $1
        AND (completed_at IS NULL OR completed_at >= now() - ($2 * interval '1 hour'))
      LIMIT 1000`,
    [userEmail.toLowerCase(), hrs],
  );
  return rows;
}

/** Open tasks for a user (by email), optionally filtered to one category, for the scorer. */
export async function getTasksForUser(userEmail: string, category?: string): Promise<ScorableTask[]> {
  await ensureBootstrapped();
  const params: unknown[] = [userEmail.toLowerCase()];
  let sql = `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,pushed_count,created_at,completed_at,assigned_agent,tags,is_scheduled,start_time
             FROM tasks.journey_tasks WHERE lower(user_email) = $1`;
  if (category) {
    params.push(category.toUpperCase());
    sql += ` AND upper(category) = $2`;
  }
  sql += ` AND completed_at IS NULL AND (status IS NULL OR status NOT IN ('DONE','BLOCKED')) LIMIT 500`;
  const { rows } = await getPool().query<ScorableTask>(sql, params);
  return rows;
}

/** Record an agent-discovered blocker (ACT-5): the specific real reason a task can't be advanced. */
export async function setTaskBlocker(userEmail: string, taskId: string, reason: string, agentId?: string | null): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_blockers (task_id, user_email, reason, agent_id, flagged_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (task_id) DO UPDATE SET reason=EXCLUDED.reason, agent_id=EXCLUDED.agent_id, flagged_at=now()`,
    [taskId, userEmail.toLowerCase(), reason.slice(0, 400), agentId ?? null],
  );
}

/** Clear a blocker once a task is unblocked/done (so a stale reason never lingers). */
export async function clearTaskBlocker(taskId: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(`DELETE FROM tasks.task_blockers WHERE task_id = $1`, [taskId]);
}

/** All active blockers for a user as task_id → {reason, agentId}, for the standup/surfacing. */
export async function getTaskBlockers(userEmail: string): Promise<Map<string, { reason: string; agentId: string | null }>> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ task_id: string; reason: string; agent_id: string | null }>(
    `SELECT task_id, reason, agent_id FROM tasks.task_blockers WHERE lower(user_email) = $1`,
    [userEmail.toLowerCase()],
  );
  return new Map(rows.map((r) => [r.task_id, { reason: r.reason, agentId: r.agent_id }]));
}

/** The last-groomed backlog signature for a user (null if never groomed), for the auto-groom change gate. */
export async function getGroomSignature(userEmail: string): Promise<string | null> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ signature: string | null }>(
    `SELECT signature FROM tasks.groom_state WHERE lower(user_email) = $1`,
    [userEmail.toLowerCase()],
  );
  return rows[0]?.signature ?? null;
}

/** Record the backlog signature we just groomed at, so an unchanged backlog is skipped next cadence fire. */
export async function setGroomSignature(userEmail: string, signature: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.groom_state (user_email, signature, last_groomed_at)
     VALUES ($1,$2,now())
     ON CONFLICT (user_email) DO UPDATE SET signature=EXCLUDED.signature, last_groomed_at=now()`,
    [userEmail.toLowerCase(), signature],
  );
}

/** The last auto-work signature for a user (null if never run), for the ACT-5 change gate. */
export async function getAutoWorkSignature(userEmail: string): Promise<string | null> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ signature: string | null }>(
    `SELECT signature FROM tasks.autowork_state WHERE lower(user_email) = $1`,
    [userEmail.toLowerCase()],
  );
  return rows[0]?.signature ?? null;
}

/** Record the auto-work signature just processed, so an unchanged backlog is skipped next fire. */
export async function setAutoWorkSignature(userEmail: string, signature: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.autowork_state (user_email, signature, last_worked_at)
     VALUES ($1,$2,now())
     ON CONFLICT (user_email) DO UPDATE SET signature=EXCLUDED.signature, last_worked_at=now()`,
    [userEmail.toLowerCase(), signature],
  );
}

/**
 * Open tasks that are ASSIGNED to an agent and not blocked — the candidates an agent can attempt
 * autonomously (ACT-5). "Blocked" is authoritative from `tasks.task_blockers` (a row an agent wrote when
 * it genuinely couldn't advance the task) — Huddle-native and immediate, so it never depends on the async
 * journey status round-trip. (status=BLOCKED is also excluded as a belt-and-suspenders.) Priority first.
 */
export async function getOpenAssignedTasks(userEmail: string, limit = 200): Promise<BoardTaskRow[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<BoardTaskRow>(
    `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,assigned_agent,tags
       FROM tasks.journey_tasks t
      WHERE lower(user_email) = $1
        AND completed_at IS NULL
        AND (status IS NULL OR status NOT IN ('DONE','BLOCKED'))
        AND assigned_agent IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks.task_blockers b WHERE b.task_id = t.id)
      ORDER BY priority_rank NULLS LAST, updated_at DESC
      LIMIT $2`,
    [userEmail.toLowerCase(), limit],
  );
  return rows;
}

// ---- General recurring-job scheduler (Azure Huddle PG) ---------------------------------------------

export interface ScheduledJob {
  id: string;
  job_type: string;
  target_email: string;
  cadence: { tz?: string; hours?: number[] };
  meta: Record<string, unknown>;
}

/** Distinct emails that currently have an OPEN backlog — the users an auto-groom job should exist for. */
export async function getUsersWithOpenBacklog(): Promise<string[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ email: string }>(
    `SELECT DISTINCT lower(user_email) AS email
       FROM tasks.journey_tasks
      WHERE user_email IS NOT NULL
        AND completed_at IS NULL AND (status IS NULL OR status NOT IN ('DONE','BLOCKED'))`,
  );
  return rows.map((r) => r.email).filter(Boolean);
}

/** Upsert a scheduled job (idempotent on id). Only seeds next_run_at when the row is first created. */
export async function upsertScheduledJob(job: {
  id: string;
  jobType: string;
  targetEmail: string;
  cadence: { tz?: string; hours?: number[] };
  nextRunAt: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.scheduled_jobs (id, job_type, target_email, cadence, next_run_at, meta)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       job_type = EXCLUDED.job_type,
       target_email = EXCLUDED.target_email,
       cadence = EXCLUDED.cadence,
       meta = EXCLUDED.meta,
       updated_at = now()`,
    [
      job.id,
      job.jobType,
      job.targetEmail.toLowerCase(),
      JSON.stringify(job.cadence),
      job.nextRunAt,
      JSON.stringify(job.meta ?? {}),
    ],
  );
}

/**
 * Atomically CLAIM all due jobs: push their next_run_at ~90s out (a hold so a concurrent tick can't
 * re-claim) and return them. The dispatcher then computes each job's real next slot and writes it
 * back via setScheduledJobNextRun. FOR UPDATE SKIP LOCKED makes concurrent ticks safe.
 */
export async function claimDueScheduledJobs(limit = 20): Promise<ScheduledJob[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<ScheduledJob>(
    `UPDATE tasks.scheduled_jobs j
        SET last_run_at = now(), next_run_at = now() + interval '90 seconds', updated_at = now()
      WHERE j.id IN (
        SELECT id FROM tasks.scheduled_jobs
         WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
         ORDER BY next_run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, job_type, target_email, cadence, meta`,
    [limit],
  );
  return rows;
}

/** Write a job's real next fire time (computed by the dispatcher with DST-correct local-time logic). */
export async function setScheduledJobNextRun(id: string, nextRunAtIso: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE tasks.scheduled_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1`,
    [id, nextRunAtIso],
  );
}

/** A mirror row shaped for the Kanban board (all tasks, including done). */
export interface BoardTaskRow {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  category: string | null;
  is_priority: boolean | null;
  priority_rank: number | null;
  due_date: string | null;
  completed_at: string | null;
  assigned_agent: string | null;
  tags: string[] | null;
}

/** Diagnostics: how many rows the mirror holds and under which emails (top 12). */
export async function getMirrorStats(): Promise<{ total: number; byEmail: { email: string | null; n: number }[] }> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ email: string | null; n: number }>(
    `SELECT lower(user_email) AS email, count(*)::int AS n
       FROM tasks.journey_tasks GROUP BY 1 ORDER BY n DESC LIMIT 12`,
  );
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  return { total, byEmail: rows };
}

/** All of a user's mirrored tasks for the board (newest-updated first, capped). */
export async function getBoardTasks(userEmail: string): Promise<BoardTaskRow[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<BoardTaskRow>(
    `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,assigned_agent,tags
       FROM tasks.journey_tasks
      WHERE lower(user_email) = $1
      ORDER BY updated_at DESC
      LIMIT 500`,
    [userEmail.toLowerCase()],
  );
  return rows;
}

export interface CeremonyRunRecord {
  id: string;
  user_email: string;
  ceremony_type: string;
  mode?: string | null;
  status?: string | null;
  summary?: string | null;
  transcript: unknown;
  auto_run?: boolean | null;
}

/** Persist a ceremony run (transcript + summary) so it's reviewable later. */
export async function recordCeremonyRun(r: CeremonyRunRecord): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.ceremony_runs (id,user_email,ceremony_type,mode,status,summary,transcript,auto_run)
     VALUES ($1,$2,$3,$4,COALESCE($5,'completed'),$6,$7,COALESCE($8,false))
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, summary=EXCLUDED.summary, transcript=EXCLUDED.transcript`,
    [
      r.id, r.user_email, r.ceremony_type, r.mode ?? null, r.status ?? null,
      r.summary ?? null, JSON.stringify(r.transcript ?? []), r.auto_run ?? null,
    ],
  );
}

export interface CeremonyRunRow {
  id: string;
  ceremony_type: string;
  mode: string | null;
  status: string | null;
  summary: string | null;
  transcript: { agentId: string; text: string }[];
  auto_run: boolean | null;
  created_at: string;
}

/** Recent ceremony runs for a user (newest first), for the review thread / virtual-meeting view. */
export async function getCeremonyRuns(userEmail: string, limit = 20): Promise<CeremonyRunRow[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<CeremonyRunRow>(
    `SELECT id,ceremony_type,mode,status,summary,transcript,auto_run,created_at
       FROM tasks.ceremony_runs WHERE lower(user_email)=$1 ORDER BY created_at DESC LIMIT $2`,
    [userEmail.toLowerCase(), limit],
  );
  return rows;
}
