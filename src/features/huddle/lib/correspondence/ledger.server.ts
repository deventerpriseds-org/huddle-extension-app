// WHAT:       Azure PG storage for correspondence ingest: (1) chat.correspondence_ledger, one row per source
//             item keyed (source, source_item_id), holding identity, a content hash, a processing status and
//             result ids -- the durable "have we handled this message" record; (2)
//             chat.correspondence_cursor, the eTag of the source file last ingested per owner + source, plus
//             when it was last checked (the read throttle).
// WHY:        Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) L54-60 + AC
//             docs/ac/AC-correspondence-checklist.md section 3: idempotent across reruns and restarts, a
//             failed write is retried (never marked processed), bounded retries, error CATEGORIES only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ledger-sql.test.ts (this SQL against a real PostgreSQL);
//             docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// Pool/bootstrap pattern of lib/fireflies/minutes-store.server.ts (the SHARED pool, idempotent DDL, lazy
// bootstrap). NEVER stores a body, subject, sender address, chat name or token: ids, hashes, statuses,
// timestamps and short error categories only. The lease + claim_version shape is the Fireflies queue's,
// including its D9 lesson: a pass the host kills before it finishes still uses up an attempt, so a
// poison item ends in a visible terminal `failed`, never an invisible retry-forever.
import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import type {
  ClaimedItem,
  CorrespondenceSource,
  CursorStore,
  LedgerStatus,
  LedgerStore,
  ObserveResult,
  SourceItem,
} from "./source-item";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.AZURE_PG_URL) throw new Error("AZURE_PG_URL not configured");
  _pool = getSharedPool();
  return _pool;
}

/** How long a claimed item is held before another pass may take it (a killed pass's claim lapses). */
export const LEDGER_LEASE_SECONDS = 300;

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.correspondence_ledger (
  source              TEXT NOT NULL CHECK (source IN ('email','teams','transcript')),
  source_item_id      TEXT NOT NULL,                 -- mailbox:outlook id | chatId:messageId | meeting_id
  owner_email         TEXT NOT NULL,
  identity_basis      TEXT NOT NULL,                 -- provider_id | drive_item_etag | meeting_id
  thread_id           TEXT,                          -- email conversationId / Teams chat id
  item_at             TIMESTAMPTZ,                   -- the item's OWN time, never the capture time
  drive_path          TEXT,
  drive_item_id       TEXT,
  file_etag           TEXT,
  internet_message_id TEXT,
  content_hash        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processed','needs_context','failed_retryable','failed')),
  missing_field       TEXT,                          -- set with needs_context (sent_items, owner_teams_id, ...)
  attempts            INT NOT NULL DEFAULT 0,        -- passes started on the current content
  claim_version       BIGINT NOT NULL DEFAULT 0,     -- bumped by every claim and every content change
  lease_until         TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_ids          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"bell":[...],"proposals":[...]}
  last_error_category TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- moves only when content or status moves
  processed_at        TIMESTAMPTZ,
  PRIMARY KEY (source, source_item_id)
);
CREATE INDEX IF NOT EXISTS correspondence_ledger_due_idx
  ON chat.correspondence_ledger (owner_email, source, next_attempt_at)
  WHERE status IN ('pending','failed_retryable');
CREATE TABLE IF NOT EXISTS chat.correspondence_cursor (
  owner_email  TEXT NOT NULL,
  source       TEXT NOT NULL,
  file_etag    TEXT,                 -- eTag of the source file last ingested into the ledger
  checked_at   TIMESTAMPTZ,          -- last time the source file was looked at (read throttle)
  observed_at  TIMESTAMPTZ,          -- last time a new file version was ingested
  PRIMARY KEY (owner_email, source)
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

/** The ledger columns of one item. The in-memory payload (email / teams) is deliberately NOT here. */
function row(i: SourceItem) {
  return {
    source: i.source,
    source_item_id: i.sourceItemId,
    identity_basis: i.identityBasis,
    thread_id: i.threadId,
    item_at: i.at,
    drive_path: i.drivePath,
    drive_item_id: i.driveItemId,
    file_etag: i.fileEtag,
    internet_message_id: i.internetMessageId,
    content_hash: i.contentHash,
  };
}

export const pgLedger: LedgerStore = {
  async observe(owner, items): Promise<ObserveResult> {
    if (!items.length) return { inserted: 0, changed: 0, unchanged: 0 };
    await ensureBootstrapped();
    // One statement per batch. `prev` reads the snapshot BEFORE the upsert, so changed vs unchanged is
    // measured against the stored hash. A changed hash resets the SAME row to pending with a fresh attempt
    // budget and bumps claim_version so an in-flight pass's mark on the old content no longer applies
    // (AC-3.4). An unchanged row only has last_seen_at touched (AC-3.5).
    const r = await getPool().query<{ inserted: number; changed: number; unchanged: number }>(
      `WITH input AS (
         SELECT DISTINCT ON (source, source_item_id) * FROM jsonb_to_recordset($2::jsonb) AS x(
           source text, source_item_id text, identity_basis text, thread_id text, item_at timestamptz,
           drive_path text, drive_item_id text, file_etag text, internet_message_id text, content_hash text)
       ),
       prev AS (
         SELECT l.source, l.source_item_id, l.content_hash FROM chat.correspondence_ledger l
           JOIN input i USING (source, source_item_id)
       ),
       up AS (
         INSERT INTO chat.correspondence_ledger AS l (source, source_item_id, owner_email, identity_basis,
           thread_id, item_at, drive_path, drive_item_id, file_etag, internet_message_id, content_hash)
         SELECT source, source_item_id, lower($1), identity_basis, thread_id, item_at, drive_path,
                drive_item_id, file_etag, internet_message_id, content_hash FROM input
         ON CONFLICT (source, source_item_id) DO UPDATE SET
           last_seen_at = now(),
           content_hash = EXCLUDED.content_hash,
           thread_id = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.thread_id ELSE l.thread_id END,
           item_at = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.item_at ELSE l.item_at END,
           drive_path = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.drive_path ELSE l.drive_path END,
           drive_item_id = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.drive_item_id ELSE l.drive_item_id END,
           file_etag = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.file_etag ELSE l.file_etag END,
           internet_message_id = COALESCE(EXCLUDED.internet_message_id, l.internet_message_id),
           status = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 'pending' ELSE l.status END,
           missing_field = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL ELSE l.missing_field END,
           attempts = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 0 ELSE l.attempts END,
           claim_version = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN l.claim_version + 1 ELSE l.claim_version END,
           lease_until = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL ELSE l.lease_until END,
           next_attempt_at = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE l.next_attempt_at END,
           updated_at = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE l.updated_at END
         RETURNING l.source, l.source_item_id, (xmax = 0) AS inserted
       )
       SELECT count(*) FILTER (WHERE up.inserted)::int AS inserted,
              count(*) FILTER (WHERE NOT up.inserted AND p.content_hash IS DISTINCT FROM i.content_hash)::int AS changed,
              count(*) FILTER (WHERE NOT up.inserted AND p.content_hash IS NOT DISTINCT FROM i.content_hash)::int AS unchanged
         FROM up JOIN input i USING (source, source_item_id) LEFT JOIN prev p USING (source, source_item_id)`,
      [owner, JSON.stringify(items.map(row))],
    );
    return r.rows[0] ?? { inserted: 0, changed: 0, unchanged: 0 };
  },

  async reopenNeedsContext(owner, source) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET status = 'pending', missing_field = NULL, next_attempt_at = now(),
              claim_version = claim_version + 1, updated_at = now()
        WHERE owner_email = lower($1) AND source = $2 AND status = 'needs_context'`,
      [owner, source],
    );
    return r.rowCount ?? 0;
  },

  async hasDue(owner, sources, maxAttempts) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `SELECT 1 FROM chat.correspondence_ledger
        WHERE owner_email = lower($1) AND source = ANY($2::text[]) AND status IN ('pending','failed_retryable')
          AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now()) AND attempts < $3
        LIMIT 1`,
      [owner, sources, maxAttempts],
    );
    return (r.rowCount ?? 0) > 0;
  },

  async claimDue(owner, sources, limit, maxAttempts) {
    await ensureBootstrapped();
    const pool = getPool();
    // D9 (the Fireflies lesson): items whose passes were all killed before finishing (lease lapsed, never
    // marked) have used up their attempts. Give them a VISIBLE terminal failure here -- no pass will.
    await pool.query(
      `UPDATE chat.correspondence_ledger SET status = 'failed', lease_until = NULL,
              last_error_category = COALESCE(last_error_category, 'gave_up:pass_did_not_finish'), updated_at = now()
        WHERE owner_email = lower($1) AND source = ANY($2::text[]) AND status IN ('pending','failed_retryable')
          AND attempts >= $3 AND (lease_until IS NULL OR lease_until < now())`,
      [owner, sources, maxAttempts],
    );
    // Compare-and-set claim (AC-3.9): FOR UPDATE SKIP LOCKED + the lease predicate mean two concurrent
    // passes never get the same item; claim_version lets a mark prove it still owns the claim.
    const r = await pool.query<{ source: CorrespondenceSource; source_item_id: string; claim_version: string; attempts: number }>(
      `UPDATE chat.correspondence_ledger l SET lease_until = now() + make_interval(secs => $5),
              claim_version = l.claim_version + 1, attempts = l.attempts + 1
        WHERE (l.source, l.source_item_id) IN (
          SELECT source, source_item_id FROM chat.correspondence_ledger
           WHERE owner_email = lower($1) AND source = ANY($2::text[]) AND status IN ('pending','failed_retryable')
             AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now()) AND attempts < $4
           ORDER BY next_attempt_at, item_at NULLS LAST LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING l.source, l.source_item_id, l.claim_version, l.attempts`,
      [owner, sources, limit, maxAttempts, LEDGER_LEASE_SECONDS],
    );
    return r.rows.map((x): ClaimedItem => ({
      source: x.source,
      sourceItemId: x.source_item_id,
      claimVersion: Number(x.claim_version),
      attempts: x.attempts,
    }));
  },

  async markProcessed(c, resultIds) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET status = 'processed', result_ids = $4::jsonb, missing_field = NULL,
              last_error_category = NULL, lease_until = NULL, processed_at = now(), updated_at = now()
        WHERE source = $1 AND source_item_id = $2 AND claim_version = $3`,
      [c.source, c.sourceItemId, c.claimVersion, JSON.stringify(resultIds)],
    );
    return (r.rowCount ?? 0) === 1;
  },

  async markNeedsContext(c, missingField) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET status = 'needs_context', missing_field = $4, lease_until = NULL,
              updated_at = now()
        WHERE source = $1 AND source_item_id = $2 AND claim_version = $3`,
      [c.source, c.sourceItemId, c.claimVersion, missingField.slice(0, 60)],
    );
    return (r.rowCount ?? 0) === 1;
  },

  async markFailed(c, category, maxAttempts) {
    await ensureBootstrapped();
    // AC-3.3/3.6: never `processed`; retryable with an exponential backoff (5, 10, 20, 40, 60 min) until the
    // attempt budget is spent, then terminal `failed` -- never a hot loop.
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET
              status = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'failed_retryable' END,
              last_error_category = $4, lease_until = NULL, updated_at = now(),
              next_attempt_at = now() + make_interval(mins => LEAST(60, 5 * (2 ^ GREATEST(attempts - 1, 0))::int))
        WHERE source = $1 AND source_item_id = $2 AND claim_version = $3`,
      [c.source, c.sourceItemId, c.claimVersion, category.slice(0, 60), maxAttempts],
    );
    return (r.rowCount ?? 0) === 1;
  },

  async health(owner) {
    await ensureBootstrapped();
    const r = await getPool().query<{ source: string; status: LedgerStatus; n: number }>(
      `SELECT source, status, count(*)::int AS n FROM chat.correspondence_ledger WHERE owner_email = lower($1)
        GROUP BY source, status`,
      [owner],
    );
    const out: Record<string, Partial<Record<LedgerStatus, number>>> = {};
    for (const x of r.rows) (out[x.source] ??= {})[x.status] = x.n;
    return out;
  },
};

export const pgCursor: CursorStore = {
  async get(owner, source) {
    await ensureBootstrapped();
    const r = await getPool().query<{ file_etag: string | null; checked_at: Date | null }>(
      `SELECT file_etag, checked_at FROM chat.correspondence_cursor WHERE owner_email = lower($1) AND source = $2`,
      [owner, source],
    );
    const x = r.rows[0];
    return x ? { etag: x.file_etag, checkedAtMs: x.checked_at ? x.checked_at.getTime() : null } : null;
  },
  async set(owner, source, etag) {
    await ensureBootstrapped();
    await getPool().query(
      `INSERT INTO chat.correspondence_cursor (owner_email, source, file_etag, checked_at, observed_at)
       VALUES (lower($1), $2, $3, now(), CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (owner_email, source) DO UPDATE SET checked_at = now(),
         file_etag = COALESCE(EXCLUDED.file_etag, chat.correspondence_cursor.file_etag),
         observed_at = CASE WHEN EXCLUDED.file_etag IS NULL THEN chat.correspondence_cursor.observed_at ELSE now() END`,
      [owner, source, etag ?? null],
    );
  },
};
