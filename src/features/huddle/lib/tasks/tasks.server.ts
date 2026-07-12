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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journey_tasks_user_email_idx ON tasks.journey_tasks (lower(user_email));
CREATE INDEX IF NOT EXISTS journey_tasks_category_idx   ON tasks.journey_tasks (category);

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
  created_at?: string | null;
  updated_at?: string | null;
}

export async function upsertJourneyTask(row: JourneyTaskPayload, userEmail?: string | null): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.journey_tasks
       (id,user_id,user_email,title,description,status,priority,category,is_priority,priority_rank,
        due_date,start_time,end_time,is_scheduled,pushed_count,board_id,completed_at,created_at,updated_at,synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'MEDIUM'),$8,COALESCE($9,false),$10,
             $11,$12,$13,COALESCE($14,false),COALESCE($15,0),$16,$17,COALESCE($18,now()),COALESCE($19,now()),now())
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id, user_email=EXCLUDED.user_email, title=EXCLUDED.title,
       description=EXCLUDED.description, status=EXCLUDED.status, priority=EXCLUDED.priority,
       category=EXCLUDED.category, is_priority=EXCLUDED.is_priority, priority_rank=EXCLUDED.priority_rank,
       due_date=EXCLUDED.due_date, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
       is_scheduled=EXCLUDED.is_scheduled, pushed_count=EXCLUDED.pushed_count, board_id=EXCLUDED.board_id,
       completed_at=EXCLUDED.completed_at, updated_at=EXCLUDED.updated_at, synced_at=now()`,
    [
      row.id, row.user_id ?? null, userEmail ?? row.user_email ?? null, row.title, row.description ?? null,
      row.status ?? null, row.priority ?? null, row.category ?? null, row.is_priority ?? null, row.priority_rank ?? null,
      row.due_date ?? null, row.start_time ?? null, row.end_time ?? null, row.is_scheduled ?? null,
      row.pushed_count ?? null, row.board_id ?? null, row.completed_at ?? null, row.created_at ?? null, row.updated_at ?? null,
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
    `SELECT id,title,status,priority,category,is_priority,due_date,pushed_count,completed_at,updated_at,created_at
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
  let sql = `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,pushed_count,created_at,completed_at
             FROM tasks.journey_tasks WHERE lower(user_email) = $1`;
  if (category) {
    params.push(category.toUpperCase());
    sql += ` AND upper(category) = $2`;
  }
  sql += ` AND completed_at IS NULL AND (status IS NULL OR status NOT IN ('DONE','BLOCKED')) LIMIT 500`;
  const { rows } = await getPool().query<ScorableTask>(sql, params);
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

/** Recent ceremony runs for a user (newest first), for the review thread / virtual-meeting view. */
export async function getCeremonyRuns(userEmail: string, limit = 20): Promise<Record<string, unknown>[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query(
    `SELECT id,ceremony_type,mode,status,summary,transcript,auto_run,created_at
       FROM tasks.ceremony_runs WHERE lower(user_email)=$1 ORDER BY created_at DESC LIMIT $2`,
    [userEmail.toLowerCase(), limit],
  );
  return rows;
}
