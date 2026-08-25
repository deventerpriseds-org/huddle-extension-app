// Durable, device-independent huddle turns. A chat turn used to be a single long-lived fetch held
// open on the user's phone for the whole "thinking" period — so backgrounding the PWA (app switch,
// screen sleep) tore down the socket and the reply was lost. Instead we PERSIST each turn here, a
// server-side runner (POST /api/public/run-turn) executes it to completion independent of the
// device, and the client picks up the finished result when it reconnects. A journey pg_cron
// heartbeat drains any turn the fire-and-forget kick missed, so a queued turn is never stranded.
//
// Same Azure-PG bootstrap pattern as tasks.server.ts / identity.server.ts.
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

// A `running` turn older than this is considered stale (the runner died mid-flight, e.g. the SWA
// function hit its ceiling) and may be re-claimed. Must comfortably exceed a real turn's wall-clock:
// a group turn with several agents each doing multi-hop tool calls can run well past a minute, and
// re-claiming a still-live turn re-executes its (non-idempotent) tool calls → duplicate task cards.
// 300s is safely above any legitimate turn while still reclaiming genuinely dead ones.
const STALE_RUNNING_SECONDS = 300;

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE IF NOT EXISTS chat.pending_turns (
  id          TEXT PRIMARY KEY,          -- client-supplied turnId (idempotency key)
  huddle_id   TEXT NOT NULL,
  user_email  TEXT,
  payload     JSONB NOT NULL,            -- the exact runHuddleTurn input
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  result      JSONB,                     -- the runHuddleTurn output once done
  error       TEXT,
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_turns_huddle_idx ON chat.pending_turns (huddle_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS pending_turns_status_idx ON chat.pending_turns (status, created_at);
-- Incremental per-agent streaming (backlog #3): a turn runs its agents in sub-45s CHUNKS. Each
-- agent reply is appended to the replies column the instant it completes (streamed to the client
-- poll); the progress column holds the resumable driver state (remaining queue + ledgers) so a
-- partial turn is continued by the runner without dropping agents; seq is the monotone reply cursor.
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS replies  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS seq      INT  NOT NULL DEFAULT 0;
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS chunks   INT  NOT NULL DEFAULT 0;
-- Barge-in queue: user interjections sent DURING a live ceremony. The ceremony driver pops one
-- between speakers (never mid-speaker), answers it, then resumes the round-robin — so a stand-up
-- pauses politely for a question instead of talking over it. FIFO array of {id,text}.
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS barge    JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Identity unification: key on the stable user_id (entra_object_id) with user_email retained as a
-- fallback + display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a
-- user's emails converge to one identity regardless of which email a caller presents.
ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS pending_turns_userid_idx ON chat.pending_turns(user_id);

-- Web Push subscriptions so a reply that lands while the user is fully away (screen off, app closed)
-- can buzz the phone. Keyed by endpoint (unique per browser/device).
CREATE TABLE IF NOT EXISTS chat.push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON chat.push_subscriptions (lower(user_email));
ALTER TABLE chat.push_subscriptions ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS push_subscriptions_userid_idx ON chat.push_subscriptions(user_id);

-- User reminders ("remind me in 30 min to ..."). A per-minute drain fires due ones: it delivers the
-- reminder into the Huddle conversation (the client polls getReminderDeliveries) and pushes the phone.
CREATE TABLE IF NOT EXISTS chat.reminders (
  id          TEXT PRIMARY KEY,
  user_email  TEXT,
  huddle_id   TEXT NOT NULL,
  agent_id    TEXT,
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'reminder', -- reminder (heads-up) | alarm (full-screen)
  due_at      TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | fired | cancelled
  fired_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chat.reminders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'reminder';
ALTER TABLE chat.reminders ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS reminders_userid_idx  ON chat.reminders(user_id);
CREATE INDEX IF NOT EXISTS reminders_due_idx    ON chat.reminders (status, due_at);
CREATE INDEX IF NOT EXISTS reminders_huddle_idx ON chat.reminders (huddle_id, fired_at DESC);

-- Liveness for the reply-push away-gate: "is the user watching THIS huddle right now?"
--
-- seen_at is stamped by the SERVER (now()), never by the client — so no clock skew, no future
-- timestamp that could pin presence on. That is only safe because the CLIENT decides whether to send
-- the heartbeat at all: it beats solely while the tab is visible AND focused AND recently touched.
-- A backgrounded tab keeps firing throttled timers, so an ungated ping would read every abandoned tab
-- as present — the gate lives on the sending side, which is what makes a server stamp honest here.
--
-- watching_huddle scopes it: activity in one DM must not silence a reply landing in another channel.
CREATE TABLE IF NOT EXISTS chat.user_presence (
  user_email      TEXT PRIMARY KEY,
  watching_huddle TEXT,
  seen_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chat.user_presence ADD COLUMN IF NOT EXISTS watching_huddle TEXT;
ALTER TABLE chat.user_presence ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
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

// 'partial' = ran a chunk, more agents remain (the runner will continue it).
export type TurnStatus = "queued" | "running" | "partial" | "done" | "error";

export interface TurnRecord {
  id: string;
  huddle_id: string;
  user_email: string | null;
  payload: Record<string, unknown>;
  status: TurnStatus;
  result: unknown;
  error: string | null;
  /** Replies produced so far (grows across chunks; the client streams these in). */
  replies: unknown[];
  /** Resumable driver state for a 'partial' turn (null once done). */
  progress: unknown;
  /** Monotone reply count — the client's per-turn streaming cursor. */
  seq: number;
  /** How many chunks this turn has run (runaway guard). */
  chunks: number;
  updated_ms: number;
}

const ROW_COLS = `id, huddle_id, user_email, payload, status, result, error, replies, progress, seq, chunks,
  (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms`;

function mapRow(r: Record<string, unknown>): TurnRecord {
  return {
    id: r.id as string,
    huddle_id: r.huddle_id as string,
    user_email: (r.user_email as string) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as TurnStatus,
    result: r.result ?? null,
    error: (r.error as string) ?? null,
    replies: (r.replies as unknown[]) ?? [],
    progress: r.progress ?? null,
    seq: Number(r.seq ?? 0),
    chunks: Number(r.chunks ?? 0),
    updated_ms: Number(r.updated_ms ?? 0),
  };
}

/**
 * Record a turn to run. Idempotent on the client-supplied turnId: a retry (e.g. the delivery loop
 * re-firing after a reconnect) never double-inserts, so the turn runs exactly once. Returns true if
 * this call created the row (i.e. the caller should kick the runner), false if it already existed.
 */
export async function enqueueTurn(
  id: string,
  huddleId: string,
  userEmail: string | null,
  payload: unknown,
): Promise<boolean> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId } = await resolveScopeByEmail(userEmail);
  const res = await getPool().query(
    `INSERT INTO chat.pending_turns (id, huddle_id, user_email, payload, status, user_id)
     VALUES ($1, $2, $3, $4::jsonb, 'queued', $5)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, huddleId, userEmail, JSON.stringify(payload), userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Atomically claim a specific queued (or stale-running) turn for execution. The conditional
 * UPDATE...RETURNING is the lock: only one caller can flip it to `running`, so the fire-and-forget
 * kick and the cron heartbeat can never run the same turn twice. Returns the row, or null if it
 * wasn't claimable (already done, or being actively run).
 */
export async function claimTurn(id: string): Promise<TurnRecord | null> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `UPDATE chat.pending_turns
       SET status = 'running', claimed_at = now(), updated_at = now()
     WHERE id = $1
       AND (status IN ('queued', 'partial')
            OR (status = 'running' AND claimed_at < now() - interval '${STALE_RUNNING_SECONDS} seconds'))
     RETURNING ${ROW_COLS}`,
    [id],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Claim the oldest queued/stale-running turn (used by the drain heartbeat). SKIP LOCKED so
 *  concurrent drainers each grab a different turn. Returns null when the queue is empty. */
export async function claimNextQueued(): Promise<TurnRecord | null> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `UPDATE chat.pending_turns
       SET status = 'running', claimed_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM chat.pending_turns
        WHERE status IN ('queued', 'partial')
           OR (status = 'running' AND claimed_at < now() - interval '${STALE_RUNNING_SECONDS} seconds')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING ${ROW_COLS}`,
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function completeTurn(id: string, result: unknown): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.pending_turns
       SET status = 'done', result = $2::jsonb, error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result ?? null)],
  );
}

/**
 * Persist one CHUNK of a resumable turn (backlog #3). `replies` is the full accumulated array so far
 * (the client reads it as the stream); `progress` is the resume state (pass null when done). When
 * `done`, the turn is finalized (status='done') and `result` is set so the existing
 * getTurnsSince/applyTurnResult consumers keep working; otherwise status='partial' and the runner
 * continues it. Bumps `seq` (=replies.length) and `chunks` (runaway guard).
 */
export async function saveTurnChunk(
  id: string,
  replies: unknown[],
  progress: unknown,
  done: boolean,
  result?: unknown,
): Promise<void> {
  await ensureBootstrapped();
  const reps = replies ?? [];
  await getPool().query(
    `UPDATE chat.pending_turns
       SET replies = $2::jsonb,
           seq = $3,
           progress = $4::jsonb,
           status = $5,
           chunks = chunks + 1,
           result = CASE WHEN $5 = 'done' THEN $6::jsonb ELSE result END,
           error = NULL,
           updated_at = now()
     WHERE id = $1`,
    [
      id,
      JSON.stringify(reps),
      reps.length,
      progress == null ? null : JSON.stringify(progress),
      done ? "done" : "partial",
      JSON.stringify(result ?? null),
    ],
  );
}

/**
 * Mid-chunk STREAMING write (backlog #3): push the replies produced so far to the client's poll the
 * instant each wave lands, WITHOUT ending the chunk. Deliberately leaves `status='running'` and does
 * NOT bump `chunks` — `chunks` counts continuation executions (the runaway guard), and a single
 * execution streams several times. `getTurnsSince` already returns 'running' rows with their replies,
 * so the client renders each wave as it arrives. Guarded on `status='running'` so it can never
 * resurrect or clobber a row another writer already finalized to done/error.
 */
export async function updateTurnReplies(
  id: string,
  replies: unknown[],
  progress: unknown,
): Promise<void> {
  await ensureBootstrapped();
  const reps = replies ?? [];
  await getPool().query(
    `UPDATE chat.pending_turns
       SET replies = $2::jsonb, seq = $3, progress = $4::jsonb, updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [id, JSON.stringify(reps), reps.length, progress == null ? null : JSON.stringify(progress)],
  );
}

/** Queue a user barge-in onto a live ceremony turn. Guarded so a finished turn ignores late barges
 *  (the ceremony's over → the client treats it as a normal message). Returns true if it was queued. */
export async function appendBarge(id: string, item: { id: string; text: string }): Promise<boolean> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `UPDATE chat.pending_turns
       SET barge = barge || $2::jsonb, updated_at = now()
     WHERE id = $1 AND status IN ('queued','running','partial')
       AND NOT (barge @> $3::jsonb)`,
    [id, JSON.stringify([item]), JSON.stringify([{ id: item.id }])],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Atomically pop the OLDEST pending barge (FIFO) for this turn, or null. Row-locked (FOR UPDATE) so a
 *  resumed chunk can never re-handle the same interjection — the idempotency guard for the barge path. */
export async function claimBarge(id: string): Promise<{ id: string; text: string } | null> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `WITH cur AS (SELECT barge FROM chat.pending_turns WHERE id = $1 FOR UPDATE)
     UPDATE chat.pending_turns t
        SET barge = t.barge - 0, updated_at = now()
       FROM cur
      WHERE t.id = $1 AND jsonb_array_length(cur.barge) > 0
      RETURNING cur.barge -> 0 AS claimed`,
    [id],
  );
  const claimed = res.rows[0]?.claimed;
  return claimed && typeof claimed.text === "string" ? claimed : null;
}

export async function failTurn(id: string, error: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.pending_turns
       SET status = 'error', error = $2, updated_at = now()
     WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

/** Turns for a huddle updated after `sinceMs` — the client's delivery/streaming read. Includes
 *  in-flight 'partial'/'running' turns (with the replies produced so far) so the client streams
 *  agent replies incrementally as chunks land, plus finished 'done'/'error' turns. The client keys
 *  on reply index (idempotent), so a partial turn re-appearing with more replies just appends. */
export async function getTurnsSince(huddleId: string, sinceMs: number): Promise<TurnRecord[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `SELECT ${ROW_COLS} FROM chat.pending_turns
      WHERE huddle_id = $1
        AND status IN ('done', 'error', 'partial', 'running')
        AND updated_at > to_timestamp($2 / 1000.0)
      ORDER BY updated_at ASC
      LIMIT 20`,
    [huddleId, Math.max(0, sinceMs)],
  );
  return res.rows.map(mapRow);
}

export async function getTurn(id: string): Promise<TurnRecord | null> {
  await ensureBootstrapped();
  const res = await getPool().query(`SELECT ${ROW_COLS} FROM chat.pending_turns WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** All FINISHED ('done') durable turns for a USER across EVERY huddle, updated after `sinceMs`.
 *  This is the GLOBAL away/cold-open back-fill read. `getTurnsSince` (above) is per-huddle and its
 *  client caller is gated on a locally-submitted turn — so an autonomous turn (grooming summary,
 *  blocker surface, standup, owner-followup) that completes in a huddle the user isn't viewing never
 *  reaches the rendered transcript, even though its push fired. This read returns each such reply with
 *  its own `huddle_id` so the client can merge it into the right conversation regardless of which
 *  huddle is open — restoring "the message is in the channel, then the notification relays it." Only
 *  'done' turns (in-flight streaming stays with the per-huddle poll). Oldest-first so the client's
 *  cursor advances monotonically; LIMIT bounds a long-away catch-up (re-poll drains the rest). */
export async function getUserTurnsSince(userEmail: string, sinceMs: number): Promise<TurnRecord[]> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const since = Math.max(0, sinceMs);
  const res = await getPool().query(
    userId
      ? `SELECT ${ROW_COLS} FROM chat.pending_turns
          WHERE (user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2)))
            AND status = 'done'
            AND updated_at > to_timestamp($3 / 1000.0)
          ORDER BY updated_at ASC
          LIMIT 100`
      : `SELECT ${ROW_COLS} FROM chat.pending_turns
          WHERE lower(user_email) = lower($1)
            AND status = 'done'
            AND updated_at > to_timestamp($2 / 1000.0)
          ORDER BY updated_at ASC
          LIMIT 100`,
    userId ? [userId, emails, since] : [userEmail, since],
  );
  return res.rows.map(mapRow);
}

// ---- Delegation / orchestration (Pillar 2) -------------------------------------------------------

export interface OrchestrationWorker {
  id: string;
  status: TurnStatus;
  /** The worker's structured result once done: { worker: { role, ok, findings, artifactId, ... } }. */
  result: unknown;
}

/** All worker sub-turn rows sharing an orchestrationId (a persona's delegated workstreams). The
 *  fan-in read: a persona's integration fires only once EVERY worker row is terminal (done/error).
 *  Keyed off the JSONB payload so no new table is needed — worker rows are pending_turns carrying
 *  `payload.worker` + a shared `payload.worker.orchestrationId`. */
export async function getOrchestrationWorkers(orchestrationId: string): Promise<OrchestrationWorker[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `SELECT id, status, result
       FROM chat.pending_turns
      WHERE payload -> 'worker' ->> 'orchestrationId' = $1
      ORDER BY created_at ASC`,
    [orchestrationId],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    status: r.status as TurnStatus,
    result: r.result ?? null,
  }));
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function savePushSubscription(
  userEmail: string,
  sub: PushSubscriptionRecord,
): Promise<void> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId } = await resolveScopeByEmail(userEmail);
  await getPool().query(
    `INSERT INTO chat.push_subscriptions (endpoint, user_email, p256dh, auth, user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_email = EXCLUDED.user_email, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_id = COALESCE(EXCLUDED.user_id, chat.push_subscriptions.user_id), updated_at = now()`,
    [sub.endpoint, userEmail, sub.p256dh, sub.auth, userId],
  );
}

export async function getPushSubscriptions(userEmail: string): Promise<PushSubscriptionRecord[]> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const res = await getPool().query(
    userId
      ? `SELECT endpoint, p256dh, auth FROM chat.push_subscriptions
          WHERE user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2))`
      : `SELECT endpoint, p256dh, auth FROM chat.push_subscriptions WHERE lower(user_email) = lower($1)`,
    userId ? [userId, emails] : [userEmail],
  );
  return res.rows.map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}

/** Remove a dead subscription (push endpoint returned 404/410 Gone). */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(`DELETE FROM chat.push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

// ---- Reminders -----------------------------------------------------------------------------------

export interface ReminderRecord {
  id: string;
  user_email: string | null;
  huddle_id: string;
  agent_id: string | null;
  text: string;
  kind: string;
  due_ms: number;
  fired_ms: number | null;
}

function mapReminder(r: Record<string, unknown>): ReminderRecord {
  return {
    id: r.id as string,
    user_email: (r.user_email as string) ?? null,
    huddle_id: r.huddle_id as string,
    agent_id: (r.agent_id as string) ?? null,
    text: r.text as string,
    kind: (r.kind as string) ?? "reminder",
    due_ms: Number(r.due_ms ?? 0),
    fired_ms: r.fired_ms == null ? null : Number(r.fired_ms),
  };
}

export async function createReminder(args: {
  id: string;
  userEmail: string | null;
  huddleId: string;
  agentId: string | null;
  text: string;
  kind: string;
  dueAtMs: number;
}): Promise<void> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId } = await resolveScopeByEmail(args.userEmail);
  await getPool().query(
    `INSERT INTO chat.reminders (id, user_email, huddle_id, agent_id, text, kind, due_at, status, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), 'pending', $8)`,
    [args.id, args.userEmail, args.huddleId, args.agentId, args.text.slice(0, 500), args.kind, args.dueAtMs, userId],
  );
}

/** Atomically claim due reminders and mark them fired, so the per-minute drain fires each exactly once. */
export async function claimDueReminders(max = 25): Promise<ReminderRecord[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `UPDATE chat.reminders SET status = 'fired', fired_at = now()
      WHERE id IN (
        SELECT id FROM chat.reminders
         WHERE status = 'pending' AND due_at <= now()
         ORDER BY due_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, user_email, huddle_id, agent_id, text, kind,
        (EXTRACT(EPOCH FROM due_at) * 1000)::bigint AS due_ms,
        (EXTRACT(EPOCH FROM fired_at) * 1000)::bigint AS fired_ms`,
    [max],
  );
  return res.rows.map(mapReminder);
}

/** Reminders that fired for a huddle after `sinceMs` — the client's in-chat delivery read. */
export async function getFiredRemindersSince(huddleId: string, sinceMs: number): Promise<ReminderRecord[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `SELECT id, user_email, huddle_id, agent_id, text, kind,
        (EXTRACT(EPOCH FROM due_at) * 1000)::bigint AS due_ms,
        (EXTRACT(EPOCH FROM fired_at) * 1000)::bigint AS fired_ms
       FROM chat.reminders
      WHERE huddle_id = $1 AND status = 'fired' AND fired_at > to_timestamp($2 / 1000.0)
      ORDER BY fired_at ASC
      LIMIT 20`,
    [huddleId, Math.max(0, sinceMs)],
  );
  return res.rows.map(mapReminder);
}

/**
 * Heartbeat cadence, and the staleness window it implies.
 *
 * The window is sized off the HEARTBEAT, not off how long a turn takes — getting that backwards is
 * exactly how the first attempt at this failed review. It was set to 30s "so it's shorter than a
 * turn", but turns run 19-24s, so a user who sent a message and immediately walked away still read as
 * present when their reply landed at ~20s: the headline bug, unfixed, behind a fix that looked right.
 *
 * Sized off the heartbeat it is unambiguous. A watching client re-stamps every PRESENCE_BEAT_MS, so
 * its row is never older than one beat plus request latency; one beat of slack covers that. A client
 * that stops watching stops stamping, and crosses the window a few seconds later — well before any
 * turn finishes. The window must stay comfortably BELOW the shortest realistic turn; widening it back
 * toward turn length is precisely the regression this comment exists to prevent.
 */
export const PRESENCE_BEAT_MS = 7_500;
export const PRESENCE_FRESH_MS = 15_000;

/**
 * Record that the user is watching `huddleId` RIGHT NOW. Called from the existing all-huddle poll —
 * no new endpoint, no new polling.
 *
 * The caller (the browser) is responsible for only calling this while genuinely watching; the server
 * stamps its own clock. See the table comment for why that split is the safe one.
 *
 * Non-throwing BY DESIGN: presence only ever SUPPRESSES a notification. If this write fails the row
 * goes stale, `isUserPresent` returns false, and the push fires. Failing loud here would risk breaking
 * the poll that also back-fills messages, to protect a de-noising optimisation.
 */
export async function recordUserPresence(userEmail: string, huddleId: string | null): Promise<void> {
  try {
    await ensureBootstrapped();
    await getPool().query(
      `INSERT INTO chat.user_presence (user_email, watching_huddle, seen_at)
            VALUES ($1, $2, now())
       ON CONFLICT (user_email) DO UPDATE
            SET watching_huddle = EXCLUDED.watching_huddle,
                seen_at = now()`,
      [userEmail, huddleId || null],
    );
  } catch {
    /* presence is best-effort — see the fail-open note above */
  }
}

/**
 * Is the user watching `huddleId` right now (heartbeat within PRESENCE_FRESH_MS)?
 *
 * Scoped to the huddle on purpose: sitting in one DM must not silence a reply arriving in another
 * channel — they would not see that one in-app, which is the entire justification for suppressing.
 *
 * FAILS OPEN (returns false = "treat as away" = push). Every uncertain path — no row, unreadable age,
 * a different huddle, a DB error — resolves to "notify them". A redundant buzz is a minor annoyance; a
 * silently swallowed reply is the bug this exists to fix, and the one the user actually lost a message
 * to. Do NOT invert this to fail-closed to reduce noise: that is the opposite of the confirm-intent
 * gate's fail-CLOSED rule next door, and copying that precedent here would restore the outage.
 *
 * Age is computed in SQL so both sides of the comparison come from the same clock.
 */
export async function isUserPresent(userEmail: string, huddleId: string): Promise<boolean> {
  if (!userEmail || !huddleId) return false;
  try {
    await ensureBootstrapped();
    const res = await getPool().query<{ age_ms: string }>(
      `SELECT EXTRACT(EPOCH FROM (now() - seen_at)) * 1000 AS age_ms
         FROM chat.user_presence
        WHERE user_email = $1 AND watching_huddle = $2`,
      [userEmail, huddleId],
    );
    const raw = res.rows[0]?.age_ms;
    if (raw === undefined || raw === null) return false;
    const age = Number(raw);
    if (!Number.isFinite(age) || age < 0) return false;
    return age < PRESENCE_FRESH_MS;
  } catch {
    return false;
  }
}
