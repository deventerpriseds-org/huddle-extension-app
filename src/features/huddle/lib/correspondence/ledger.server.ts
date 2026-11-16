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
// 2026-11-16 -- CONTENT IS NOW STORED (owner decision, verbatim: "A (recommended): store message content in Azure,
//             including Sent Items as a fourth kind next to email, Teams and transcripts." and "Make sure both the
//             raw transcript and the summary are being loaded for fireflies").
//   WHAT: one nullable JSONB column `content` holds each item's content (shapes in source-item.ts: email, sent,
//         teams, transcript); `content_purged_at` marks a row whose content aged out (purgeContent, default 90
//         days by item time, config correspondence.contentRetentionDays) and must never be written again.
//         Source 'sent' (Sent Items) joins the CHECK; sent rows are STORE-ONLY (inserted `processed`, never
//         reset to pending, never claimed -- see STORE_ONLY_SQL).
//   WHY:  Azure is the system of record; the OneDrive files are REPLACED by Power Automate every run (P-7 probe:
//         127 -> 61 -> 17 records), so without this the content is gone.
//   STILL TRUE: logs never carry content -- no body, subject, address, name, chat name, transcript text or token is
//         ever logged; counts, statuses and error categories only (AC-3.8). The previous rule "NEVER stores a body,
//         subject, sender address, chat name or token" is SUPERSEDED for storage by the owner decision above.
//   EVIDENCE: docs/qc-evidence/BUILD-correspondence-content.md; scripts/correspondence-ledger-sql.test.ts section 5
//         (migration of a table created by the OLD DDL, rows kept, 'sent' accepted).
//
// Pool/bootstrap pattern of lib/fireflies/minutes-store.server.ts (the SHARED pool, idempotent DDL, lazy
// bootstrap). The lease + claim_version shape is the Fireflies queue's,
// including its D9 lesson: a pass the host kills before it finishes still uses up an attempt, so a
// poison item ends in a visible terminal `failed`, never an invisible retry-forever.
import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import { CONTENT_RETENTION_DAYS_DEFAULT } from "../external-feeds/onedrive-feed";
import type {
  ClaimedItem,
  ContentStore,
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


export const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.correspondence_ledger (
  source              TEXT NOT NULL CHECK (source IN ('email','teams','transcript','sent')),
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
-- 2026-11-16 (owner decision: content stored in Azure). Idempotent on the LIVE table, which was created by the
-- earlier DDL: CREATE TABLE IF NOT EXISTS above does not touch an existing table, so the columns are ADDed and the
-- source CHECK (created by CREATE TABLE, auto-named) is found in pg_constraint by its definition and replaced.
ALTER TABLE chat.correspondence_ledger ADD COLUMN IF NOT EXISTS content JSONB;
ALTER TABLE chat.correspondence_ledger ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
DO $ledger_source_check$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'chat.correspondence_ledger'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%(source = ANY%'
              AND pg_get_constraintdef(oid) NOT LIKE '%''sent''%'
  LOOP
    EXECUTE format('ALTER TABLE chat.correspondence_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'chat.correspondence_ledger'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%(source = ANY%') THEN
    ALTER TABLE chat.correspondence_ledger ADD CONSTRAINT correspondence_ledger_source_check
      CHECK (source IN ('email','teams','transcript','sent'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;  -- a concurrent bootstrap added it first
END $ledger_source_check$;
CREATE INDEX IF NOT EXISTS correspondence_ledger_content_age_idx
  ON chat.correspondence_ledger ((COALESCE(item_at, first_seen_at)))
  WHERE content IS NOT NULL;
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

/** Sources never claimed by the processing pass (store-only, source-item.ts STORE_ONLY_SOURCES). A SQL literal,
 *  not a parameter, so every claim / due query carries it whatever its caller passes. */
const STORE_ONLY_SQL = `source <> 'sent'`;

/** The ledger columns of one item, including its stored content (2026-11-16). The in-memory processor payload
 *  (email / teams) is not a column; `content` is the stored shape. */
function row(i: SourceItem) {
  return {
    content: i.content ?? null,
    store_only: i.storeOnly === true,
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

export const pgLedger: LedgerStore & ContentStore = {
  async observe(owner, items): Promise<ObserveResult> {
    if (!items.length) return { inserted: 0, changed: 0, unchanged: 0 };
    await ensureBootstrapped();
    // One statement per batch. `prev` reads the snapshot BEFORE the upsert, so changed vs unchanged is
    // measured against the stored hash. A changed hash resets the SAME row to pending with a fresh attempt
    // budget and bumps claim_version so an in-flight pass's mark on the old content no longer applies
    // (AC-3.4). An unchanged row only has last_seen_at touched (AC-3.5).
    // 2026-11-16: `content` is written on insert and on a hash change; an UNCHANGED row whose content is NULL
    // (stored before content existed) is filled. A purged row (content_purged_at set) is never written again.
    // A store-only row (Sent Items) is inserted `processed` and keeps its status on a hash change.
    const r = await getPool().query<{ inserted: number; changed: number; unchanged: number; filled: number }>(
      `WITH input AS (
         SELECT DISTINCT ON (source, source_item_id) * FROM jsonb_to_recordset($2::jsonb) AS x(
           source text, source_item_id text, identity_basis text, thread_id text, item_at timestamptz,
           drive_path text, drive_item_id text, file_etag text, internet_message_id text, content_hash text,
           content jsonb, store_only boolean)
       ),
       prev AS (
         SELECT l.source, l.source_item_id, l.content_hash, (l.content IS NULL AND l.content_purged_at IS NULL) AS fillable
           FROM chat.correspondence_ledger l JOIN input i USING (source, source_item_id)
       ),
       up AS (
         INSERT INTO chat.correspondence_ledger AS l (source, source_item_id, owner_email, identity_basis,
           thread_id, item_at, drive_path, drive_item_id, file_etag, internet_message_id, content_hash, content,
           status, processed_at)
         SELECT source, source_item_id, lower($1), identity_basis, thread_id, item_at, drive_path,
                drive_item_id, file_etag, internet_message_id, content_hash, content,
                CASE WHEN store_only THEN 'processed' ELSE 'pending' END,
                CASE WHEN store_only THEN now() END FROM input
         ON CONFLICT (source, source_item_id) DO UPDATE SET
           last_seen_at = now(),
           content_hash = EXCLUDED.content_hash,
           content = CASE WHEN l.content_purged_at IS NOT NULL THEN NULL
                          WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN COALESCE(EXCLUDED.content, l.content)
                          ELSE COALESCE(l.content, EXCLUDED.content) END,
           thread_id = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.thread_id ELSE l.thread_id END,
           item_at = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.item_at ELSE l.item_at END,
           drive_path = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.drive_path ELSE l.drive_path END,
           drive_item_id = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.drive_item_id ELSE l.drive_item_id END,
           file_etag = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.file_etag ELSE l.file_etag END,
           internet_message_id = COALESCE(EXCLUDED.internet_message_id, l.internet_message_id),
           -- EXCLUDED.status is 'processed' exactly for a store-only item: a store-only row never goes back to pending.
           status = CASE WHEN l.content_hash IS DISTINCT FROM EXCLUDED.content_hash AND EXCLUDED.status <> 'processed' THEN 'pending' ELSE l.status END,
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
              count(*) FILTER (WHERE NOT up.inserted AND p.content_hash IS NOT DISTINCT FROM i.content_hash)::int AS unchanged,
              count(*) FILTER (WHERE NOT up.inserted AND p.content_hash IS NOT DISTINCT FROM i.content_hash
                                 AND p.fillable AND i.content IS NOT NULL)::int AS filled
         FROM up JOIN input i USING (source, source_item_id) LEFT JOIN prev p USING (source, source_item_id)`,
      [owner, JSON.stringify(items.map(row))],
    );
    const x = r.rows[0];
    if (!x) return { inserted: 0, changed: 0, unchanged: 0 };
    return { inserted: x.inserted, changed: x.changed, unchanged: x.unchanged, ...(x.filled ? { contentFilled: x.filled } : {}) };
  },

  async storeContent(owner, items) {
    if (!items.length) return { inserted: 0, updated: 0 };
    await ensureBootstrapped();
    // Store-only upsert: a missing row is inserted `processed`; an existing row (which meeting triage may own,
    // with its OWN content_hash and status) gets `content` written and nothing else. Purged rows stay NULL.
    const r = await getPool().query<{ inserted: number; updated: number }>(
      `WITH input AS (
         SELECT DISTINCT ON (source, source_item_id) * FROM jsonb_to_recordset($2::jsonb) AS x(
           source text, source_item_id text, identity_basis text, thread_id text, item_at timestamptz,
           drive_path text, drive_item_id text, file_etag text, internet_message_id text, content_hash text,
           content jsonb, store_only boolean)
       ),
       up AS (
         INSERT INTO chat.correspondence_ledger AS l (source, source_item_id, owner_email, identity_basis, thread_id,
           item_at, drive_path, drive_item_id, file_etag, internet_message_id, content_hash, content, status, processed_at)
         SELECT source, source_item_id, lower($1), identity_basis, thread_id, item_at, drive_path, drive_item_id,
                file_etag, internet_message_id, content_hash, content, 'processed', now() FROM input
         ON CONFLICT (source, source_item_id) DO UPDATE SET
           content = CASE WHEN l.content_purged_at IS NOT NULL THEN NULL ELSE COALESCE(EXCLUDED.content, l.content) END,
           item_at = COALESCE(l.item_at, EXCLUDED.item_at),
           last_seen_at = now()
         RETURNING (xmax = 0) AS inserted
       )
       SELECT count(*) FILTER (WHERE inserted)::int AS inserted, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`,
      [owner, JSON.stringify(items.map(row))],
    );
    return r.rows[0] ?? { inserted: 0, updated: 0 };
  },

  async purgeContent(retentionDays) {
    await ensureBootstrapped();
    const days = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : CONTENT_RETENTION_DAYS_DEFAULT;
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET content = NULL, content_purged_at = now()
        WHERE content IS NOT NULL AND COALESCE(item_at, first_seen_at) < now() - make_interval(days => $1)`,
      [days],
    );
    return r.rowCount ?? 0;
  },

  async reopenNeedsContext(owner, source) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `UPDATE chat.correspondence_ledger SET status = 'pending', missing_field = NULL, next_attempt_at = now(),
              attempts = 0, claim_version = claim_version + 1, updated_at = now()
        WHERE owner_email = lower($1) AND source = $2 AND status = 'needs_context'`,
      [owner, source],
    );
    return r.rowCount ?? 0;
  },

  async hasDue(owner, sources, maxAttempts) {
    await ensureBootstrapped();
    const r = await getPool().query(
      `SELECT 1 FROM chat.correspondence_ledger
        WHERE owner_email = lower($1) AND source = ANY($2::text[]) AND ${STORE_ONLY_SQL} AND status IN ('pending','failed_retryable')
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
           WHERE owner_email = lower($1) AND source = ANY($2::text[]) AND ${STORE_ONLY_SQL} AND status IN ('pending','failed_retryable')
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
