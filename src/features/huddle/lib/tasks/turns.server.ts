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
// function hit its ceiling) and may be re-claimed. Comfortably above a normal turn's wall-clock.
const STALE_RUNNING_SECONDS = 90;

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

export type TurnStatus = "queued" | "running" | "done" | "error";

export interface TurnRecord {
  id: string;
  huddle_id: string;
  user_email: string | null;
  payload: Record<string, unknown>;
  status: TurnStatus;
  result: unknown;
  error: string | null;
  updated_ms: number;
}

const ROW_COLS = `id, huddle_id, user_email, payload, status, result, error,
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
  const res = await getPool().query(
    `INSERT INTO chat.pending_turns (id, huddle_id, user_email, payload, status)
     VALUES ($1, $2, $3, $4::jsonb, 'queued')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, huddleId, userEmail, JSON.stringify(payload)],
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
       AND (status = 'queued'
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
        WHERE status = 'queued'
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

export async function failTurn(id: string, error: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.pending_turns
       SET status = 'error', error = $2, updated_at = now()
     WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

/** Finished turns for a huddle updated after `sinceMs` — the client's delivery-on-reconnect read. */
export async function getTurnsSince(huddleId: string, sinceMs: number): Promise<TurnRecord[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `SELECT ${ROW_COLS} FROM chat.pending_turns
      WHERE huddle_id = $1
        AND status IN ('done', 'error')
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
  await getPool().query(
    `INSERT INTO chat.push_subscriptions (endpoint, user_email, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_email = EXCLUDED.user_email, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = now()`,
    [sub.endpoint, userEmail, sub.p256dh, sub.auth],
  );
}

export async function getPushSubscriptions(userEmail: string): Promise<PushSubscriptionRecord[]> {
  await ensureBootstrapped();
  const res = await getPool().query(
    `SELECT endpoint, p256dh, auth FROM chat.push_subscriptions WHERE lower(user_email) = lower($1)`,
    [userEmail],
  );
  return res.rows.map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}

/** Remove a dead subscription (push endpoint returned 404/410 Gone). */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(`DELETE FROM chat.push_subscriptions WHERE endpoint = $1`, [endpoint]);
}
