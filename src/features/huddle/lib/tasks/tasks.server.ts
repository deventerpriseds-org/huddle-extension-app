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
  definition_of_done TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Grooming fields synced back from journey (added after the table first shipped).
ALTER TABLE tasks.journey_tasks ADD COLUMN IF NOT EXISTS assigned_agent TEXT;
ALTER TABLE tasks.journey_tasks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
-- WIP confirm-intent gate (docs/plan-wip-confirm-review-gate.md, Part 1): the DoD confirmed with the
-- user before DOING, synced back from journey's definition_of_done column.
ALTER TABLE tasks.journey_tasks ADD COLUMN IF NOT EXISTS definition_of_done TEXT;
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

-- Per-agent standup-update TEXT cache for the "current-optimized" ceremony engine (ACT-huddle-18).
-- Keyed to the SAME backlogSignature the groom_state watermark uses (hash over open tasks'
-- id/title/status/due_date + count) so parking/editing/deleting a task changes the key and a stale
-- entry is never read. TEXT ONLY — never audio: the cloned ElevenLabs voice is chosen at synth time by
-- agentId. The slot column distinguishes the host's opener from its closer (both terry-locke) and each
-- owner's lane update. Filled as a grooming payoff (same pass as setGroomSignature) and by the ceremony
-- cold-path fan-out. One row per (user, ceremony, slot).
CREATE TABLE IF NOT EXISTS tasks.standup_cache (
  user_email    TEXT NOT NULL,
  ceremony_type TEXT NOT NULL,
  slot          TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  update_text   TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, ceremony_type, slot)
);
CREATE INDEX IF NOT EXISTS standup_cache_sig_idx ON tasks.standup_cache (lower(user_email), ceremony_type, signature);

-- Change-detection watermark for ACT-5 auto-work (agents self-starting research on assigned tasks).
-- Same idea as groom_state: skip a pass when the open-assigned backlog hasn't changed since last run.
CREATE TABLE IF NOT EXISTS tasks.autowork_state (
  user_email     TEXT PRIMARY KEY,
  signature      TEXT,
  last_worked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Watermark for the standup's "moved to review since last standup" bucket. tasks.scheduled_jobs'
-- last_run_at is overwritten at CLAIM time (before the job body runs), so it can't answer "since when
-- did I last actually build a brief" -- this small dedicated table (same pattern as groom/autowork
-- state) owns that read/write point itself.
CREATE TABLE IF NOT EXISTS tasks.standup_state (
  user_email      TEXT PRIMARY KEY,
  last_standup_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- WIP confirm-intent gate + hardened review gate (docs/plan-wip-confirm-review-gate.md). One row per
-- task, Huddle-native bookkeeping (journey only holds the confirmed definition_of_done itself).
-- confirm_status: awaiting (not yet asked) -> asked (jittered ask fired, waiting on the user's reply)
-- -> confirmed (DoD locked, eligible for UP_NEXT->DOING promotion). confirm_ask_at is a ONE-TIME
-- jittered instant, set once and never recomputed (see ensureConfirmAskAt's set-once guard) so an
-- unanswered ask can't be pushed out forever. revision_count is Part 2's corrective-pass counter for
-- the post-create_artifact review gate. next_review_ping_at drives the 48h post-review recheck.
CREATE TABLE IF NOT EXISTS tasks.task_engagement_state (
  task_id             TEXT PRIMARY KEY,
  user_email          TEXT NOT NULL,
  confirm_status      TEXT NOT NULL DEFAULT 'awaiting',
  proposed_dod        TEXT,
  confirmed_dod       TEXT,
  confirm_ask_at      TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  last_review_ping_at TIMESTAMPTZ,
  next_review_ping_at TIMESTAMPTZ,
  revision_count      INT NOT NULL DEFAULT 0,
  entered_review_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_engagement_state_email_idx ON tasks.task_engagement_state (lower(user_email));
-- entered_review_at: stamped whenever a task actually moves to IN_REVIEW (create_artifact's gated
-- markTaskInReview call) -- the standup "moved to review" bucket reads this delta since the last run.
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS entered_review_at TIMESTAMPTZ;
-- Approach gate (docs/plan-approach-clarify-gate.md): AFTER confirm_status='confirmed' (DoD locked with
-- the user), the assigned agent drafts an APPROACH (the how) and a sub-agent (approach-gate.server.ts)
-- grades it pass/revise — bounded, invisible to the user unless the cap is exhausted. approach_status:
-- pending (not yet approved) -> approved (eligible for real DOING work) | escalated (cap exhausted, the
-- agent told the user directly instead of looping forever).
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS approach_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS proposed_approach TEXT;
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS approach_revision_count INT NOT NULL DEFAULT 0;
-- Mid-work clarifying question (ask_clarifying_question tool): clarify_status='open' pauses that task's
-- autowork research cadence until answered. clarify_count is the lifetime cap counter (bounded — an agent
-- that's still stuck after the cap must flag_blocker or proceed on its own judgment, not keep asking).
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS clarify_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS clarify_count INT NOT NULL DEFAULT 0;
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS open_question TEXT;
ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS open_question_asked_at TIMESTAMPTZ;

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
  definition_of_done?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export async function upsertJourneyTask(row: JourneyTaskPayload, userEmail?: string | null): Promise<void> {
  await ensureBootstrapped();

  // Reassignment invalidates confirm-intent/approach state (relearned 2026-08-05): confirm_status and
  // approach_status are earned by the AGENT who did the asking/proposing — if grooming (or anything
  // else) hands the task to a DIFFERENT agent, that new agent must not silently inherit 'confirmed'/
  // 'approved' status it never itself produced, or it sails straight to DOING/IN_REVIEW without ever
  // asking the user. Compare against the currently-mirrored assigned_agent BEFORE the upsert overwrites it.
  const incomingAgent = row.assigned_agent ?? null;
  if (incomingAgent) {
    const prevAgent = await getTaskAssignedAgent(row.id);
    if (prevAgent && prevAgent !== incomingAgent) {
      await resetEngagementOnReassignment(row.id).catch(() => {});
    }
  }

  await getPool().query(
    `INSERT INTO tasks.journey_tasks
       (id,user_id,user_email,title,description,status,priority,category,is_priority,priority_rank,
        due_date,start_time,end_time,is_scheduled,pushed_count,board_id,completed_at,assigned_agent,tags,definition_of_done,created_at,updated_at,synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'MEDIUM'),$8,COALESCE($9,false),$10,
             $11,$12,$13,COALESCE($14,false),COALESCE($15,0),$16,$17,$18,COALESCE($19::text[],'{}'::text[]),$20,COALESCE($21,now()),COALESCE($22,now()),now())
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id, user_email=EXCLUDED.user_email, title=EXCLUDED.title,
       description=EXCLUDED.description, status=EXCLUDED.status, priority=EXCLUDED.priority,
       category=EXCLUDED.category, is_priority=EXCLUDED.is_priority, priority_rank=EXCLUDED.priority_rank,
       due_date=EXCLUDED.due_date, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
       is_scheduled=EXCLUDED.is_scheduled, pushed_count=EXCLUDED.pushed_count, board_id=EXCLUDED.board_id,
       completed_at=EXCLUDED.completed_at, assigned_agent=EXCLUDED.assigned_agent, tags=EXCLUDED.tags,
       definition_of_done=EXCLUDED.definition_of_done,
       updated_at=EXCLUDED.updated_at, synced_at=now()`,
    [
      row.id, row.user_id ?? null, userEmail ?? row.user_email ?? null, row.title, row.description ?? null,
      row.status ?? null, row.priority ?? null, row.category ?? null, row.is_priority ?? null, row.priority_rank ?? null,
      row.due_date ?? null, row.start_time ?? null, row.end_time ?? null, row.is_scheduled ?? null,
      row.pushed_count ?? null, row.board_id ?? null, row.completed_at ?? null, row.assigned_agent ?? null,
      row.tags ?? null, row.definition_of_done ?? null, row.created_at ?? null, row.updated_at ?? null,
    ],
  );

  // Reverse-clear (keep journey↔Huddle blocked in sync). journey's `tasks` is the canonical source of
  // truth; when a task syncs in with a status that is NOT 'BLOCKED' (the user/agent unblocked it, marked
  // it done, moved it back to TODO/IN_PROGRESS, etc.), the Huddle-native blocker row is stale and must go
  // — otherwise standup/auto-work would keep surfacing a task the user already unblocked. Guarded on the
  // incoming journey `updated_at`: only clear a blocker whose `flagged_at` PRECEDES this update, so a
  // stale in-flight TODO sync (async pg_net can deliver out of order) can't wipe a blocker just written by
  // flag_blocker. status=BLOCKED (the forward direction) is intentionally left untouched.
  const incomingStatus = (row.status ?? "").toUpperCase();
  if (incomingStatus && incomingStatus !== "BLOCKED" && row.updated_at) {
    await getPool()
      .query(`DELETE FROM tasks.task_blockers WHERE task_id = $1 AND flagged_at < $2`, [row.id, row.updated_at])
      .catch(() => {}); // non-fatal: the mirror upsert is what matters; a failed clear self-heals next sync
  }
}

export async function deleteJourneyTask(id: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(`DELETE FROM tasks.journey_tasks WHERE id = $1`, [id]);
}

// Pure decision for the B2 assignee-scoped status guard — separated so it is unit-testable with no DB.
// TRUE = the change must be DEFERRED (winner is neither the assignee nor the board owner). Fails OPEN
// (returns false) for everything ambiguous: not update_task, no status field (title/date edits),
// board owner, no resolvable task id, unassigned/unknown task, or the winner IS the assignee.
export function shouldDeferStatusChange(input: {
  toolName: string;
  status: unknown;
  taskId: string;
  isBoardOwner: boolean;
  assignee: string | null;
  winnerId: string;
}): boolean {
  if (input.toolName !== "update_task") return false;
  if (input.status == null || String(input.status).trim() === "") return false;
  if (input.isBoardOwner) return false;
  if (!input.taskId) return false;
  if (!input.assignee || input.assignee === input.winnerId) return false;
  return true;
}

// The agent a task is assigned to (its `assigned_agent`), or null if unassigned / unknown / not yet
// mirrored. Read-only, used by the B2 assignee-scoped status-change guard. Returns null (never throws)
// on any error so the guard can fail OPEN — a DB hiccup must never block a legitimate task update.
export async function getTaskAssignedAgent(id: string): Promise<string | null> {
  if (!id) return null;
  try {
    await ensureBootstrapped();
    const r = await getPool().query<{ assigned_agent: string | null }>(
      `SELECT assigned_agent FROM tasks.journey_tasks WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.assigned_agent ?? null;
  } catch {
    return null;
  }
}

/** A task's title, for the approach gate's grading prompt. Fails open (empty string) on any error. */
export async function getTaskTitle(id: string): Promise<string> {
  if (!id) return "";
  try {
    await ensureBootstrapped();
    const r = await getPool().query<{ title: string | null }>(`SELECT title FROM tasks.journey_tasks WHERE id = $1`, [id]);
    return r.rows[0]?.title ?? "";
  } catch {
    return "";
  }
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
        -- PARKING LOT (ACT-6.2): a task the user deliberately set aside must NEVER surface in a
        -- ceremony update. Filter it at the SOURCE so EVERY consumer (the round-robin in
        -- huddle.functions.ts AND the current-optimized cache/fan-out) gets an already-clean set —
        -- buildCeremonyReport does not filter it, and rankTasks/grooming only filter their own paths.
        AND NOT ('parking-lot' = ANY(tags))
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

/** One cached per-agent ceremony-update line (TEXT only — the voice is chosen at synth time by agentId). */
export interface StandupCacheEntry {
  slot: string;
  agent_id: string;
  update_text: string;
}

/**
 * Read the per-agent standup-update cache, but ONLY the rows matching the current backlog signature —
 * a signature mismatch returns nothing, so a stale (pre-change) script is never spoken. Ordered by
 * insertion so the caller can reconstruct the spoken order.
 */
export async function getStandupCache(
  userEmail: string,
  ceremonyType: string,
  signature: string,
): Promise<StandupCacheEntry[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<StandupCacheEntry>(
    `SELECT slot, agent_id, update_text FROM tasks.standup_cache
      WHERE lower(user_email) = $1 AND ceremony_type = $2 AND signature = $3
      ORDER BY updated_at`,
    [userEmail.toLowerCase(), ceremonyType, signature],
  );
  return rows;
}

/**
 * Replace the standup cache for one (user, ceremony) at a given signature. Upserts each slot and then
 * clears any row left over from an OLDER signature, so getStandupCache (which filters by signature) can
 * only ever return a consistent, current set. Only fully-generated scripts should be written here — a
 * failed slot must be OMITTED (never cache a failed generation).
 */
export async function setStandupCache(
  userEmail: string,
  ceremonyType: string,
  signature: string,
  entries: { slot: string; agentId: string; text: string }[],
): Promise<void> {
  if (!entries.length) return;
  await ensureBootstrapped();
  const email = userEmail.toLowerCase();
  for (const e of entries) {
    await getPool().query(
      `INSERT INTO tasks.standup_cache (user_email, ceremony_type, slot, agent_id, signature, update_text)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_email, ceremony_type, slot) DO UPDATE
         SET agent_id = EXCLUDED.agent_id, signature = EXCLUDED.signature,
             update_text = EXCLUDED.update_text, updated_at = now()`,
      [email, ceremonyType, e.slot, e.agentId, signature, e.text],
    );
  }
  // Drop any slot that belongs to a superseded signature (e.g. a participant who dropped out).
  await getPool()
    .query(
      `DELETE FROM tasks.standup_cache
        WHERE lower(user_email) = $1 AND ceremony_type = $2 AND signature <> $3`,
      [email, ceremonyType, signature],
    )
    .catch(() => {});
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

/** The previous standup run's instant (null if never run), for the "moved to review since" bucket. */
export async function getLastStandupAt(userEmail: string): Promise<string | null> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ last_standup_at: string }>(
    `SELECT last_standup_at FROM tasks.standup_state WHERE lower(user_email) = $1`,
    [userEmail.toLowerCase()],
  );
  return rows[0]?.last_standup_at ?? null;
}

/** Record this standup run's instant, so the NEXT run's "moved to review" bucket starts from here. */
export async function setLastStandupAt(userEmail: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.standup_state (user_email, last_standup_at)
     VALUES ($1, now())
     ON CONFLICT (user_email) DO UPDATE SET last_standup_at = now()`,
    [userEmail.toLowerCase()],
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
    `SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,assigned_agent,tags,definition_of_done
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

/** The WIP confirm-intent + review gate's per-task bookkeeping (docs/plan-wip-confirm-review-gate.md). */
export interface TaskEngagementState {
  task_id: string;
  user_email: string;
  confirm_status: "awaiting" | "asked" | "confirmed";
  proposed_dod: string | null;
  confirmed_dod: string | null;
  confirm_ask_at: string | null;
  confirmed_at: string | null;
  last_review_ping_at: string | null;
  next_review_ping_at: string | null;
  revision_count: number;
  entered_review_at: string | null;
  approach_status: "pending" | "approved" | "escalated";
  proposed_approach: string | null;
  approach_revision_count: number;
  clarify_status: "none" | "open";
  clarify_count: number;
  open_question: string | null;
  open_question_asked_at: string | null;
}

const ENGAGEMENT_COLS =
  "task_id,user_email,confirm_status,proposed_dod,confirmed_dod,confirm_ask_at,confirmed_at,last_review_ping_at,next_review_ping_at,revision_count,entered_review_at," +
  "approach_status,proposed_approach,approach_revision_count,clarify_status,clarify_count,open_question,open_question_asked_at";

/** Batch-read engagement state for a set of task ids (a missing entry means "never asked yet"). */
export async function getTaskEngagementStates(taskIds: string[]): Promise<Map<string, TaskEngagementState>> {
  if (!taskIds.length) return new Map();
  await ensureBootstrapped();
  const { rows } = await getPool().query<TaskEngagementState>(
    `SELECT ${ENGAGEMENT_COLS} FROM tasks.task_engagement_state WHERE task_id = ANY($1::text[])`,
    [taskIds],
  );
  return new Map(rows.map((r) => [r.task_id, r]));
}

export async function getTaskEngagementState(taskId: string): Promise<TaskEngagementState | null> {
  const m = await getTaskEngagementStates([taskId]);
  return m.get(taskId) ?? null;
}

/**
 * Set a task's ONE-TIME jittered confirm-ask instant, but only if it doesn't already have one — a
 * later call (e.g. next autowork pass, still before the jitter elapses) must NOT recompute a fresh
 * value, or the ask would get pushed out forever. Creates the row in 'awaiting' status if it doesn't
 * exist yet.
 */
export async function ensureConfirmAskAt(taskId: string, userEmail: string, askAtIso: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, confirm_status, confirm_ask_at)
     VALUES ($1,$2,'awaiting',$3)
     ON CONFLICT (task_id) DO UPDATE SET
       confirm_ask_at = COALESCE(tasks.task_engagement_state.confirm_ask_at, EXCLUDED.confirm_ask_at),
       updated_at = now()`,
    [taskId, userEmail.toLowerCase(), askAtIso],
  );
}

/**
 * Force-overwrite an armed-but-unsent confirm-ask time. Unlike ensureConfirmAskAt (set-once via
 * COALESCE), this UNCONDITIONALLY moves the instant — used ONLY to re-fan a STRAGGLER: an ask whose
 * confirm_ask_at landed outside every fan-out window (e.g. armed the old now+jitter way, or unsent
 * when a window closed). It relocates that ask to a random instant inside the next open window so the
 * batch spreads across the window instead of dumping at its opening edge. Only ever called for rows
 * still in 'awaiting' (never touches an already-'asked'/'confirmed' row) so it can't resurrect a sent
 * ask. No-op if the row doesn't exist or has already advanced past 'awaiting'.
 */
export async function reArmConfirmAskAt(taskId: string, userEmail: string, askAtIso: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE tasks.task_engagement_state
       SET confirm_ask_at = $3, updated_at = now()
     WHERE task_id = $1 AND lower(user_email) = lower($2) AND confirm_status = 'awaiting'`,
    [taskId, userEmail.toLowerCase(), askAtIso],
  );
}

/**
 * Transition awaiting -> asked (the confirm-intent DM was just enqueued). Returns whether THIS call
 * made the transition, so a caller can tell "I just enqueued it" from "someone else already did."
 */
export async function markConfirmAsked(taskId: string): Promise<boolean> {
  await ensureBootstrapped();
  const { rowCount } = await getPool().query(
    `UPDATE tasks.task_engagement_state SET confirm_status='asked', updated_at=now()
      WHERE task_id = $1 AND confirm_status = 'awaiting'`,
    [taskId],
  );
  return (rowCount ?? 0) > 0;
}

export interface DueConfirmAsk {
  task_id: string;
  user_email: string;
  assigned_agent: string | null;
  title: string;
  category: string | null;
  tags: string[] | null;
}

/**
 * Armed-but-unsent confirm-intent asks whose jittered `confirm_ask_at` has elapsed — i.e. due to FIRE
 * NOW. Read every heartbeat by the scheduler so each ask goes out at its own jittered instant (random
 * fan-out across the working day) instead of batching to the 3x/day auto-work pass. Only 'awaiting' rows
 * with a due `confirm_ask_at` on a still-open, agent-assigned task; ordered oldest-due first.
 */
export async function getDueConfirmAsks(nowIso: string, limit = 100): Promise<DueConfirmAsk[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<DueConfirmAsk>(
    `SELECT es.task_id, es.user_email, jt.assigned_agent, jt.title, jt.category, jt.tags
       FROM tasks.task_engagement_state es
       JOIN tasks.journey_tasks jt
         ON jt.id = es.task_id AND lower(jt.user_email) = lower(es.user_email)
      WHERE es.confirm_status = 'awaiting'
        AND es.confirm_ask_at IS NOT NULL
        AND es.confirm_ask_at <= $1::timestamptz
        AND jt.assigned_agent IS NOT NULL
        AND upper(coalesce(jt.status, '')) <> 'DONE'
        AND NOT ('parking-lot' = ANY(jt.tags))
      ORDER BY es.confirm_ask_at ASC
      LIMIT $2`,
    [nowIso, limit],
  );
  return rows;
}

/**
 * The task (if any) whose confirm-intent ask is OUTSTANDING for a given agent+user — i.e. the agent
 * already sent the reach-out (`confirm_status='asked'`) and is waiting on the user's reply. Used by the
 * turn engine to recognize that a user's DM message IS the response to a pending confirmation, so it can
 * record `confirm_task_intent` deterministically instead of hoping the model calls the tool. Most-recent
 * asked task wins (a DM has one active confirmation at a time in practice).
 */
export async function getPendingConfirmForAgent(
  userEmail: string,
  agentId: string,
): Promise<{ taskId: string; title: string; proposedDod: string | null } | null> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ task_id: string; title: string; proposed_dod: string | null }>(
    `SELECT es.task_id, jt.title, es.proposed_dod
       FROM tasks.task_engagement_state es
       JOIN tasks.journey_tasks jt
         ON jt.id = es.task_id AND lower(jt.user_email) = lower(es.user_email)
      WHERE lower(es.user_email) = lower($1)
        AND jt.assigned_agent = $2
        AND es.confirm_status = 'asked'
        AND upper(coalesce(jt.status, '')) <> 'DONE'
      ORDER BY es.updated_at DESC
      LIMIT 1`,
    [userEmail, agentId],
  );
  if (!rows.length) return null;
  return { taskId: rows[0].task_id, title: rows[0].title, proposedDod: rows[0].proposed_dod };
}

/** Stamp the instant a task actually moved to IN_REVIEW — call wherever markTaskInReview is called. */
export async function markEnteredReview(taskId: string, userEmail: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, entered_review_at)
     VALUES ($1,$2,now())
     ON CONFLICT (task_id) DO UPDATE SET entered_review_at = now(), updated_at = now()`,
    [taskId, userEmail.toLowerCase()],
  );
}

/** Task ids that entered IN_REVIEW at or after `sinceIso`, for the standup's "moved to review" bucket. */
export async function getTaskEngagementStatesSince(userEmail: string, sinceIso: string): Promise<Set<string>> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ task_id: string }>(
    `SELECT task_id FROM tasks.task_engagement_state WHERE lower(user_email) = $1 AND entered_review_at >= $2`,
    [userEmail.toLowerCase(), sinceIso],
  );
  return new Set(rows.map((r) => r.task_id));
}

/**
 * Set a task's ONE-TIME jittered next 48h review-recheck instant, but only if it doesn't already have
 * one — mirrors ensureConfirmAskAt's set-once guard, so a task that's been IN_REVIEW a while (deployed
 * before this feature shipped) gets seeded once rather than immediately firing on the next pass.
 */
export async function ensureNextReviewPing(taskId: string, userEmail: string, whenIso: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, next_review_ping_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (task_id) DO UPDATE SET
       next_review_ping_at = COALESCE(tasks.task_engagement_state.next_review_ping_at, EXCLUDED.next_review_ping_at),
       updated_at = now()`,
    [taskId, userEmail.toLowerCase(), whenIso],
  );
}

/** Reschedule the NEXT 48h review-recheck after one just fired (unconditional, unlike the set-once seed). */
export async function rescheduleNextReviewPing(taskId: string, whenIso: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE tasks.task_engagement_state
        SET next_review_ping_at = $2, last_review_ping_at = now(), updated_at = now()
      WHERE task_id = $1`,
    [taskId, whenIso],
  );
}

/**
 * Bump the hardened review gate's corrective-pass counter (docs/plan-wip-confirm-review-gate.md,
 * Part 2 correction #3) and return the new count, so the caller can enforce EXACTLY one revision —
 * a second 'revise' verdict must fail open rather than loop forever.
 */
export async function incrementRevisionCount(taskId: string, userEmail: string): Promise<number> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ revision_count: number }>(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, revision_count)
     VALUES ($1,$2,1)
     ON CONFLICT (task_id) DO UPDATE SET
       revision_count = tasks.task_engagement_state.revision_count + 1, updated_at = now()
     RETURNING revision_count`,
    [taskId, userEmail.toLowerCase()],
  );
  return rows[0]?.revision_count ?? 1;
}

// ---- Approach gate (extends the review gate to the START of work, not just the end) ----------------
// After confirm_task_intent locks the DoD, the assigned agent drafts an APPROACH and a sub-agent
// (approach-gate.server.ts) grades it pass/revise, bounded by a configurable per-agent cap. Mirrors
// incrementRevisionCount's shape exactly, just for the approach-revision counter.

/** Bump the approach gate's corrective-pass counter and return the new count. */
export async function incrementApproachRevisionCount(taskId: string, userEmail: string): Promise<number> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ approach_revision_count: number }>(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, approach_revision_count)
     VALUES ($1,$2,1)
     ON CONFLICT (task_id) DO UPDATE SET
       approach_revision_count = tasks.task_engagement_state.approach_revision_count + 1, updated_at = now()
     RETURNING approach_revision_count`,
    [taskId, userEmail.toLowerCase()],
  );
  return rows[0]?.approach_revision_count ?? 1;
}

/** The approach gate passed — lock in the approach and make the task eligible for real DOING work. */
export async function approveApproach(taskId: string, userEmail: string, approach: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, approach_status, proposed_approach)
     VALUES ($1,$2,'approved',$3)
     ON CONFLICT (task_id) DO UPDATE SET
       approach_status='approved', proposed_approach=EXCLUDED.proposed_approach, updated_at=now()`,
    [taskId, userEmail.toLowerCase(), approach],
  );
}

/** The approach gate's cap was exhausted without a pass — escalate to the user instead of looping. */
export async function escalateApproach(taskId: string, userEmail: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, approach_status)
     VALUES ($1,$2,'escalated')
     ON CONFLICT (task_id) DO UPDATE SET approach_status='escalated', updated_at=now()`,
    [taskId, userEmail.toLowerCase()],
  );
}

// ---- Mid-work clarifying question (bounded, rate-limited — see ask_clarifying_question tool) --------

/**
 * Open a clarifying question for a task — pauses autowork's research cadence for it until answered.
 * Returns the new lifetime count so the caller can enforce the configurable per-task cap; only one
 * question may be open at a time (enforced by the caller checking clarify_status first).
 */
export async function openClarifyingQuestion(taskId: string, userEmail: string, question: string): Promise<number> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ clarify_count: number }>(
    `INSERT INTO tasks.task_engagement_state
       (task_id, user_email, clarify_status, clarify_count, open_question, open_question_asked_at)
     VALUES ($1,$2,'open',1,$3,now())
     ON CONFLICT (task_id) DO UPDATE SET
       clarify_status='open', clarify_count = tasks.task_engagement_state.clarify_count + 1,
       open_question=EXCLUDED.open_question, open_question_asked_at=now(), updated_at=now()
     RETURNING clarify_count`,
    [taskId, userEmail.toLowerCase(), question],
  );
  return rows[0]?.clarify_count ?? 1;
}

/** The agent has what it needed — resume normal autowork research cadence for this task. */
export async function closeClarifyingQuestion(taskId: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE tasks.task_engagement_state
        SET clarify_status='none', open_question=NULL, updated_at=now()
      WHERE task_id = $1`,
    [taskId],
  );
}

/** Lock in the confirmed Definition of Done (the confirm_task_intent tool handler calls this). */
export async function confirmTaskIntent(taskId: string, userEmail: string, dod: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO tasks.task_engagement_state (task_id, user_email, confirm_status, confirmed_dod, confirmed_at)
     VALUES ($1,$2,'confirmed',$3,now())
     ON CONFLICT (task_id) DO UPDATE SET
       confirm_status='confirmed', confirmed_dod=EXCLUDED.confirmed_dod, confirmed_at=now(), updated_at=now()`,
    [taskId, userEmail.toLowerCase(), dod],
  );
}

/**
 * A task's assignee changed (e.g. a grooming re-pass) — the previous assignee's confirm-intent/approach
 * state was earned by THEM, not the new assignee, so it must not silently carry over (the new agent
 * would otherwise inherit 'confirmed'/'approved' status it never itself proposed to the user, and sail
 * straight to DOING/IN_REVIEW without asking — the same failure mode as the 2026-08-05 incident, just
 * via reassignment instead of a stale-mirror race). Resets to a clean slate so the new assignee goes
 * through the full ask + approach process. A no-op if the task has no engagement row yet.
 */
export async function resetEngagementOnReassignment(taskId: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE tasks.task_engagement_state
        SET confirm_status='awaiting', proposed_dod=NULL, confirmed_dod=NULL, confirm_ask_at=NULL,
            confirmed_at=NULL, revision_count=0,
            approach_status='pending', proposed_approach=NULL, approach_revision_count=0,
            clarify_status='none', clarify_count=0, open_question=NULL, open_question_asked_at=NULL,
            updated_at=now()
      WHERE task_id = $1`,
    [taskId],
  );
}

/**
 * Flip a task DOING -> IN_REVIEW the instant finished work is saved, retrying once before giving up
 * silently. This replaces a bare fire-and-forget journey write that used to swallow its own failure
 * (huddle.functions.ts's old markTaskInReview): if the write failed, the task kept its artifact but
 * never left DOING, and nothing ever looked at it again — autowork.server.ts treats "has an artifact"
 * as "already handled," so the task was permanently stuck with no signal to the user. Five real tasks
 * were found stranded this way for ~9 days (2026-08-04 incident).
 *
 * On a second consecutive failure, flag it via the SAME task_blockers mechanism flag_blocker uses
 * (setTaskBlocker) instead of retrying forever — getOpenAssignedTasks already excludes blocked tasks,
 * so this surfaces the stall in the user's blocked report rather than looping silently.
 */
export async function ensureReviewFlip(
  taskId: string,
  userEmail: string,
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  agentId?: string | null,
): Promise<{ ok: boolean; blocked: boolean; pendingConfirm?: boolean }> {
  // Defense-in-depth for the WIP confirm-intent gate: no task may reach IN_REVIEW without the user
  // having confirmed the agent's assumed action + Definition of Done first (confirm_task_intent),
  // regardless of how it got into DOING — autowork's own promotion path is gated separately
  // (autowork.server.ts), but this is the single choke point every create_artifact dispatch path
  // shares, so it's the one place that closes the gap for ALL of them at once.
  {
    const { isStructuredWorkflowRequired, isStructuredWorkflowRequiredForUser } = await import(
      "../identity/agent-workflow-config.server"
    );
    // Resolve the requirement even when the caller passed a null agentId (the WorkerPayload
    // `w.personaId ?? null` path) — previously `if (agentId)` skipped the gate entirely for a null
    // persona, a genuine bypass. With no agent, fall back to the user-level default. Both resolvers
    // fail CLOSED (require confirmation on a config-read error), and the flip requires an AFFIRMATIVE
    // confirm_status==='confirmed' — never "proceed unless proven required" — so no combination of a
    // null agent, a fail-open, or a stale read can push unconfirmed work into review.
    const required = agentId
      ? await isStructuredWorkflowRequired(userEmail, agentId)
      : await isStructuredWorkflowRequiredForUser(userEmail);
    if (required) {
      const state = await getTaskEngagementState(taskId);
      if (state?.confirm_status !== "confirmed") {
        return { ok: false, blocked: false, pendingConfirm: true };
      }
    }
  }
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  const attempt = async (): Promise<boolean> => {
    try {
      const r = await invokeJourneyTool({
        toolName: "update_task",
        args: { task_id: taskId, status: "IN_REVIEW" },
        caller: caller ?? {},
        context: { source: "huddle" },
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 2; i++) {
    if (await attempt()) {
      await markEnteredReview(taskId, userEmail).catch(() => {});
      const REVIEW_PING_BASE_MS = 48 * 60 * 60_000;
      const REVIEW_PING_JITTER_MS = 2 * 60 * 60_000;
      await ensureNextReviewPing(
        taskId,
        userEmail,
        new Date(Date.now() + REVIEW_PING_BASE_MS + Math.random() * REVIEW_PING_JITTER_MS).toISOString(),
      ).catch(() => {});
      await clearTaskBlocker(taskId).catch(() => {});
      return { ok: true, blocked: false };
    }
  }
  await setTaskBlocker(
    userEmail,
    taskId,
    "Finished work couldn't be marked ready for review after two attempts — needs a look.",
    agentId ?? null,
  ).catch(() => {});
  return { ok: false, blocked: true };
}

// ---- General recurring-job scheduler (Azure Huddle PG) ---------------------------------------------

export interface ScheduledJob {
  id: string;
  job_type: string;
  target_email: string;
  // daysOfWeek uses JS Date.getDay() convention: 0=Sun..6=Sat. Omitted/empty = every day.
  cadence: { tz?: string; hours?: number[]; daysOfWeek?: number[] };
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

/** Upsert a scheduled job (idempotent on id). Only seeds next_run_at when the row is first created.
 * `cadence` IS refreshed on every call (ON CONFLICT), so a live config change (e.g. a user editing
 * the Scheduling settings panel) takes effect on the job's NEXT fire without needing to delete/
 * recreate the row — only next_run_at is left alone so a pending fire isn't disturbed mid-flight. */
export async function upsertScheduledJob(job: {
  id: string;
  jobType: string;
  targetEmail: string;
  cadence: { tz?: string; hours?: number[]; daysOfWeek?: number[] };
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

/** Write a job's real next fire time (computed by the dispatcher with DST-correct local-time logic).
 * Optionally also self-heals the stored `cadence` column to the freshly-resolved value the dispatcher
 * just used, so a direct DB read reflects reality even if ensureGroomJobs hasn't touched this row. */
export async function setScheduledJobNextRun(
  id: string,
  nextRunAtIso: string,
  cadence?: { tz?: string; hours?: number[]; daysOfWeek?: number[] },
): Promise<void> {
  await ensureBootstrapped();
  if (cadence) {
    await getPool().query(
      `UPDATE tasks.scheduled_jobs SET next_run_at = $2, cadence = $3::jsonb, updated_at = now() WHERE id = $1`,
      [id, nextRunAtIso, JSON.stringify(cadence)],
    );
  } else {
    await getPool().query(
      `UPDATE tasks.scheduled_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1`,
      [id, nextRunAtIso],
    );
  }
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
  definition_of_done: string | null;
  // The agent's saved outputs for this task (newest first), so the board card can link to them the same
  // way the chat thread does. Populated by getBoardTasks; absent on getOpenAssignedTasks (auto-work path).
  artifacts?: { id: string; name: string; status: string | null }[];
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

/** All of a user's mirrored tasks for the board (newest-updated first, capped). Each row carries its
 * saved artifacts (id + name + status, newest first) so a card can link to the agent's creations the
 * same way the chat thread does. The artifact join is best-effort: if the artifacts schema isn't present
 * (fresh DB before any artifact was ever saved), it falls back to the plain task query. */
export async function getBoardTasks(userEmail: string): Promise<BoardTaskRow[]> {
  await ensureBootstrapped();
  const email = userEmail.toLowerCase();
  const withArtifacts = `
    SELECT t.id,t.title,t.status,t.priority,t.category,t.is_priority,t.priority_rank,t.due_date,
           t.completed_at,t.assigned_agent,t.tags,t.definition_of_done,
           COALESCE((
             SELECT json_agg(json_build_object('id',a.id,'name',a.name,'status',a.status) ORDER BY a.created_at DESC)
               FROM artifacts.items a
              WHERE a.task_id = t.id AND lower(a.user_email) = $1
           ), '[]'::json) AS artifacts
      FROM tasks.journey_tasks t
     WHERE lower(t.user_email) = $1
     ORDER BY t.updated_at DESC
     LIMIT 500`;
  const plain = `
    SELECT id,title,status,priority,category,is_priority,priority_rank,due_date,completed_at,assigned_agent,tags,definition_of_done
      FROM tasks.journey_tasks
     WHERE lower(user_email) = $1
     ORDER BY updated_at DESC
     LIMIT 500`;
  try {
    const { rows } = await getPool().query<BoardTaskRow>(withArtifacts, [email]);
    return rows;
  } catch {
    // artifacts.items not bootstrapped yet (or transient) — the board still works without the links.
    const { rows } = await getPool().query<BoardTaskRow>(plain, [email]);
    return rows;
  }
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
