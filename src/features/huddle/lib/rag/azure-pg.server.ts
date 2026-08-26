// Azure Postgres + pgvector implementation of RagStore. Uses `pg` over TCP.
// AZURE_PG_URL is a full connection string (postgresql://user:pass@host:5432/db?sslmode=require).
//
// Errors are NEVER swallowed here. Every method throws on failure. Callers
// decide whether to record a user-visible fallback. The old "lazy bootstrap"
// has been removed — schema creation is now an explicit runBootstrap() call
// the user triggers from Settings, so the UI can never falsely claim tables
// exist when they don't.

import { Pool, Client } from "pg";
import { embed, toPgVector, EMBED_DIM } from "./embed.server";
import type {
  ChunkRow,
  LookupTriplesInput,
  RagStore,
  SearchChunksInput,
  TripleRow,
  WriteChunkInput,
  WriteTripleInput,
} from "./types";

export class RagStoreUnavailableError extends Error {
  cause: unknown;
  /**
   * The underlying Postgres SQLSTATE (e.g. "42P10", "23505"), lifted off the driver error.
   *
   * `q()` wraps EVERY pg error in this class, so without this field a caller could not branch on
   * what actually went wrong -- a store-unavailable and a specific, recoverable constraint error
   * were indistinguishable. That is not hypothetical: writeChunk's 42P10 fallback was written
   * against `err.code` and was DEAD CODE, because the wrapper never carried one.
   */
  code?: string;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RagStoreUnavailableError";
    this.cause = cause;
    const c = (cause as { code?: unknown } | undefined)?.code;
    if (typeof c === "string") this.code = c;
  }
}

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new RagStoreUnavailableError("AZURE_PG_URL not configured");
  _pool = new Pool({
    connectionString: url,
    // Azure Postgres requires TLS. Node's default CA store lacks the DigiCert
    // roots on some runtimes; skip cert verification to keep this portable.
    // Encryption still applies — only the cert-chain check is skipped.
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) {
  try {
    return await getPool().query<T>(sql, params);
  } catch (err) {
    throw new RagStoreUnavailableError(
      `Azure Postgres query failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * The rag_chunks write-time dedup key, as ONE string interpolated into BOTH the CREATE UNIQUE INDEX
 * below and writeChunk's ON CONFLICT target.
 *
 * They must match expression-for-expression -- Postgres infers which index to use from the expression
 * list -- and they used to be two independent literals ~350 lines apart, kept in sync by a comment
 * saying "these must not drift". Nothing MADE that true, and drift now degrades silently: a mismatch
 * raises 42P10, which writeChunk deliberately catches and falls back to a duplicate-producing plain
 * INSERT behind a console.warn, on a path whose three production callers are all fire-and-forget. The
 * app would keep working while memory quietly re-accumulated duplicates, with no user-visible signal.
 * One constant makes the drift impossible instead of merely discouraged.
 */
const CHUNK_DEDUP_KEY = `scope, coalesce(agent_id, ''), coalesce(source, ''), md5(text), length(text)`;

/**
 * The rag_triples write-time dedup key, and the PARTIAL-index predicate that goes with it. Same
 * one-constant discipline as CHUNK_DEDUP_KEY -- and a partial index adds a second thing that must
 * stay in sync, because Postgres can only infer a partial index when the ON CONFLICT clause repeats
 * its WHERE predicate. Both live here so neither can drift.
 *
 * LIVE ROWS ONLY. Superseded rows are the record of what a fact USED to be; two of them with the same
 * values are history, not duplication, and a full-table unique index would also break the supersede
 * path (re-asserting a fact after it was superseded is legitimate and must still insert).
 *
 * Only `object` is hashed. Measured on the live store: subject 66 bytes, predicate 59, object 809 --
 * subject and predicate are short by nature (entity and relation names) and stay READABLE in the
 * index, while `object` is free model-generated text with no schema cap and is the only one that
 * could approach the ~2704-byte btree tuple limit. length(object) rides along so an md5 collision
 * cannot silently merge two different facts. lower() is safe: measured ZERO triples that differ only
 * by case, so normalising collapses nothing real.
 */
const TRIPLE_DEDUP_KEY = `scope, coalesce(agent_id, ''), lower(subject), lower(predicate), md5(lower(object)), length(object)`;
const TRIPLE_DEDUP_PRED = `superseded_at IS NULL`;

export const BOOTSTRAP_SQL = `
-- Azure's azure.extensions allow-list can reject CREATE EXTENSION even for an extension that is
-- ALREADY installed and working (e.g. after the allow-list was reset/tightened post-install). That
-- made the whole bootstrap batch throw on line 1 and the Settings buttons show a false "vector not
-- allow-listed" failure while the live store kept working. Swallow that error ONLY when vector is in
-- fact present; re-raise when it is genuinely missing so a real problem still fails loudly.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE rag_scope AS ENUM ('agent', 'global');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope rag_scope NOT NULL,
  agent_id TEXT,
  text TEXT NOT NULL,
  source TEXT,
  embedding vector(${EMBED_DIM}) NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE rag_chunks  ADD COLUMN IF NOT EXISTS author_agent_ids TEXT[] DEFAULT '{}';

-- pgvector: ivfflat/hnsw over the raw vector type cap at 2000 dims, but
-- text-embedding-3-large is 3072. Index a halfvec cast instead (pgvector >= 0.7).
DROP INDEX IF EXISTS rag_chunks_embed_ivf;
CREATE INDEX IF NOT EXISTS rag_chunks_embed_hnsw
  ON rag_chunks USING hnsw ((embedding::halfvec(${EMBED_DIM})) halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS rag_chunks_agent_idx
  ON rag_chunks (agent_id) WHERE scope = 'agent';
CREATE INDEX IF NOT EXISTS rag_chunks_authors_idx
  ON rag_chunks USING gin (author_agent_ids);

-- Write-time dedup key. Before this existed, writeChunk was a bare INSERT with no constraint and the
-- live store had drifted to 716 rows / 579 distinct -- 137 exact duplicates (19%), one phrase stored
-- 36 times -- each of them competing for the handful of slots auto-retrieval injects per turn.
-- Three deliberate choices, each measured on the live store rather than assumed:
--   * md5(text), never raw text. The longest chunk is 2732 BYTES; a btree tuple caps near 2704, so a
--     raw-text key would ERROR on insert for exactly the longest, most content-rich memories.
--     length(text) rides along so an md5 collision cannot silently swallow a distinct memory.
--   * coalesce(), not bare columns. agent_id is NULL on every scope='global' row and NULLs compare
--     DISTINCT in a unique index by default -- a naive UNIQUE(scope, agent_id, ...) would have caught
--     none of the global duplicates, which is all of them. (PG17 offers NULLS NOT DISTINCT; coalesce
--     is version-proof and reads the same way the ON CONFLICT clause does.)
--   * source IS in the key. Measured: zero texts span more than one source, so including it collapses
--     nothing extra -- but the Settings memory drawer DISPLAYS source per row, so keeping it means a
--     collapse can never silently rewrite where something was said.
-- Guarded like the CREATE EXTENSION above, and for the same reason: ONE failing statement aborts the
-- whole bootstrap batch, and everything below this line -- including CREATE TABLE rag_triples -- would
-- never run. The catch is WHEN OTHERS, matching that block: duplicates (23505) are the EXPECTED failure
-- on a DB that missed the one-off cleanup, but insufficient privilege (42501), disk full (53100) and
-- index-row-size (54000 -- the very class md5() was chosen to dodge) would each lose the triples table
-- just as thoroughly. The index is best-effort either way: log and continue, leaving that DB on the
-- pre-dedup behaviour writeChunk already falls back to.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_dedup_idx ON rag_chunks (${CHUNK_DEDUP_KEY});
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'rag_chunks_dedup_idx not created (SQLSTATE %): %. Memory still works, without write-time dedup.', SQLSTATE, SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS rag_triples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope rag_scope NOT NULL,
  agent_id TEXT,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL DEFAULT 0.8,
  source_chunk_id UUID REFERENCES rag_chunks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE rag_triples ADD COLUMN IF NOT EXISTS author_agent_ids TEXT[] DEFAULT '{}';
-- "researched" memory mode: supersession marker so a changed fact hides the stale prior value.
ALTER TABLE rag_triples ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS rag_triples_subject_idx ON rag_triples (subject);
CREATE INDEX IF NOT EXISTS rag_triples_live_key_idx
  ON rag_triples (scope, lower(subject), lower(predicate)) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS rag_triples_fts_idx
  ON rag_triples USING gin (to_tsvector('english', subject || ' ' || predicate || ' ' || object));
CREATE INDEX IF NOT EXISTS rag_triples_authors_idx
  ON rag_triples USING gin (author_agent_ids);

-- Write-time dedup for LIVE triples. writeTriples was a bare INSERT with no constraint, the same gap
-- rag_chunks had, from the SAME call sites in the SAME turn off the SAME user text -- measured at 32
-- duplicate groups / 55 excess rows (11%), of which 24 groups / 35 rows are live. Partial, so the
-- superseded history is untouched and re-asserting a previously-superseded fact still inserts.
-- Guarded WHEN OTHERS for the same reason as the chunks index above: a DB still holding live
-- duplicates fails here (23505), and an unguarded failure would abort the remainder of the batch.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS rag_triples_dedup_idx
    ON rag_triples (${TRIPLE_DEDUP_KEY}) WHERE ${TRIPLE_DEDUP_PRED};
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'rag_triples_dedup_idx not created (SQLSTATE %): %. Facts still work, without write-time dedup.', SQLSTATE, SQLERRM;
END $$;
`;

/**
 * Explicit schema bootstrap. Returns a raw report so the UI can display it.
 * Never called implicitly by store methods — the user runs this from
 * Agent Settings → Memory DB.
 */
export async function runBootstrap(): Promise<{
  ok: boolean;
  ranSql: string;
  error?: { message: string; code?: string; detail?: string };
  extensions: string[];
  tables: { rag_chunks: boolean; rag_triples: boolean };
  /**
   * Whether the two write-time dedup indexes actually EXIST after the batch ran.
   *
   * Both CREATE UNIQUE INDEX statements are wrapped in `DO $$ … EXCEPTION WHEN OTHERS … RAISE WARNING`
   * so one failure cannot abort the batch and cost us the tables below it. The cost of that safety is
   * that a failure is now INVISIBLE: on a database still holding duplicate rows the index fails 23505,
   * the warning goes to a notice channel nobody is subscribed to, this function checked only
   * information_schema.tables and returned ok:true, and writeChunk/writeTriples then quietly fell back
   * to plain duplicate-producing INSERTs. The whole feature would report green while doing nothing.
   * Reporting presence is what closes that gap -- `ok` means the batch ran, these mean it WORKED.
   */
  indexes: { rag_chunks_dedup: boolean; rag_triples_dedup: boolean };
}> {
  const url = process.env.AZURE_PG_URL;
  if (!url) {
    return {
      ok: false,
      ranSql: BOOTSTRAP_SQL,
      error: { message: "AZURE_PG_URL not configured" },
      extensions: [],
      tables: { rag_chunks: false, rag_triples: false },
      indexes: { rag_chunks_dedup: false, rag_triples_dedup: false },
    };
  }
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query(BOOTSTRAP_SQL);
    const ext = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension ORDER BY extname",
    );
    const t = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('rag_chunks','rag_triples')",
    );
    const names = new Set(t.rows.map((r) => r.table_name));
    const idx = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public'
          AND indexname IN ('rag_chunks_dedup_idx','rag_triples_dedup_idx')`,
    );
    const idxNames = new Set(idx.rows.map((r) => r.indexname));
    return {
      ok: true,
      ranSql: BOOTSTRAP_SQL,
      extensions: ext.rows.map((r) => r.extname),
      tables: { rag_chunks: names.has("rag_chunks"), rag_triples: names.has("rag_triples") },
      indexes: {
        rag_chunks_dedup: idxNames.has("rag_chunks_dedup_idx"),
        rag_triples_dedup: idxNames.has("rag_triples_dedup_idx"),
      },
    };
  } catch (err) {
    const e = err as { message?: string; code?: string; detail?: string };
    return {
      ok: false,
      ranSql: BOOTSTRAP_SQL,
      error: {
        message: e.message ?? String(err),
        code: e.code,
        detail: e.detail,
      },
      extensions: [],
      tables: { rag_chunks: false, rag_triples: false },
      indexes: { rag_chunks_dedup: false, rag_triples_dedup: false },
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface DiagnoseResult {
  connectionString: {
    configured: boolean;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    sslmode?: string;
    parseError?: string;
  };
  dns: { ok: boolean; addresses?: string[]; error?: string; ms?: number };
  tcp: { ok: boolean; ms?: number; error?: string };
  handshake: {
    ok: boolean;
    ms?: number;
    error?: { message: string; code?: string; severity?: string; routine?: string; detail?: string };
  };
  server: {
    version?: string;
    extensions?: string[];
    tables?: { rag_chunks: boolean; rag_triples: boolean };
    /** Write-time dedup indexes. Absent = duplicates are re-accumulating; see runBootstrap's note. */
    indexes?: { rag_chunks_dedup: boolean; rag_triples_dedup: boolean };
    rows?: { rag_chunks: number; rag_triples: number };
  };
  timestamp: string;
}

function parseConnectionString(url: string): DiagnoseResult["connectionString"] {
  try {
    const u = new URL(url);
    return {
      configured: true,
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      database: u.pathname.replace(/^\//, "") || undefined,
      user: decodeURIComponent(u.username) || undefined,
      sslmode: u.searchParams.get("sslmode") ?? undefined,
    };
  } catch (err) {
    return {
      configured: true,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const net = await import("node:net");
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: { ok: boolean; error?: string }) => {
      socket.destroy();
      resolve({ ...result, ms: Date.now() - start });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, error: `TCP connect timed out after ${timeoutMs}ms` }));
    socket.once("error", (err) => done({ ok: false, error: err.message }));
    try {
      socket.connect(port, host);
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Deep diagnostic: DNS → raw TCP → Postgres handshake → schema check.
 * Never throws. Returns the ground truth about every layer.
 */
export async function diagnoseAzurePg(): Promise<DiagnoseResult> {
  const url = process.env.AZURE_PG_URL;
  const result: DiagnoseResult = {
    connectionString: { configured: !!url },
    dns: { ok: false },
    tcp: { ok: false },
    handshake: { ok: false },
    server: {},
    timestamp: new Date().toISOString(),
  };

  if (!url) {
    result.connectionString.parseError = "AZURE_PG_URL not configured";
    return result;
  }

  result.connectionString = parseConnectionString(url);
  const host = result.connectionString.host;
  const port = result.connectionString.port ?? 5432;
  if (!host) return result;

  // DNS
  try {
    const dns = await import("node:dns/promises");
    const t0 = Date.now();
    const addrs = await dns.lookup(host, { all: true });
    result.dns = {
      ok: true,
      addresses: addrs.map((a) => `${a.address} (v${a.family})`),
      ms: Date.now() - t0,
    };
  } catch (err) {
    result.dns = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return result;
  }

  // Raw TCP probe (5s)
  result.tcp = await probeTcp(host, port, 5000);
  if (!result.tcp.ok) return result;

  // Real Postgres handshake with fresh client
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  const hs0 = Date.now();
  try {
    await client.connect();
    result.handshake = { ok: true, ms: Date.now() - hs0 };

    const ver = await client.query<{ version: string }>("SELECT version()");
    result.server.version = ver.rows[0]?.version;

    const ext = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension ORDER BY extname",
    );
    result.server.extensions = ext.rows.map((r) => r.extname);

    const t = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('rag_chunks','rag_triples')",
    );
    const names = new Set(t.rows.map((r) => r.table_name));
    result.server.tables = {
      rag_chunks: names.has("rag_chunks"),
      rag_triples: names.has("rag_triples"),
    };

    const rows = { rag_chunks: 0, rag_triples: 0 };
    if (names.has("rag_chunks")) {
      const c = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM rag_chunks");
      rows.rag_chunks = Number(c.rows[0]?.n ?? 0);
    }
    if (names.has("rag_triples")) {
      const c = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM rag_triples");
      rows.rag_triples = Number(c.rows[0]?.n ?? 0);
    }
    result.server.rows = rows;

    // Surface dedup-index presence in the diagnostic too, not just runBootstrap -- this is the panel
    // the user actually looks at, and an index that failed to create is exactly the condition that
    // otherwise looks identical to everything being fine.
    const idx = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public'
          AND indexname IN ('rag_chunks_dedup_idx','rag_triples_dedup_idx')`,
    );
    const idxNames = new Set(idx.rows.map((r) => r.indexname));
    result.server.indexes = {
      rag_chunks_dedup: idxNames.has("rag_chunks_dedup_idx"),
      rag_triples_dedup: idxNames.has("rag_triples_dedup_idx"),
    };
  } catch (err) {
    const e = err as { message?: string; code?: string; severity?: string; routine?: string; detail?: string };
    result.handshake = {
      ok: false,
      ms: Date.now() - hs0,
      error: {
        message: e.message ?? String(err),
        code: e.code,
        severity: e.severity,
        routine: e.routine,
        detail: e.detail,
      },
    };
  } finally {
    await client.end().catch(() => undefined);
  }

  return result;
}

/**
 * Compose the WHERE fragment for scope filtering based on the caller's sharing mode.
 */
function scopeClause(
  mode: "shared" | "private" | "readonly-shared" | undefined,
  scope: "agent" | "global" | undefined,
  agentId: string | undefined,
) {
  if (mode === "private" && agentId) {
    return { sql: `(scope = 'agent' AND agent_id = $AGENT)`, params: [agentId] as unknown[] };
  }
  if (mode === "readonly-shared") {
    return { sql: `scope = 'global'`, params: [] as unknown[] };
  }
  if (scope === "global") return { sql: `scope = 'global'`, params: [] as unknown[] };
  if (agentId) {
    return {
      sql: `(scope = 'global' OR (scope = 'agent' AND agent_id = $AGENT))`,
      params: [agentId] as unknown[],
    };
  }
  return { sql: `TRUE`, params: [] as unknown[] };
}

export const azurePgStore: RagStore = {
  async bootstrap() {
    const r = await runBootstrap();
    if (!r.ok) {
      throw new RagStoreUnavailableError(
        `Bootstrap failed: ${r.error?.message ?? "unknown error"}`,
        r.error,
      );
    }
  },

  async ping() {
    // Kept for the RagStore interface but the diagnostic fn is what the UI uses.
    const d = await diagnoseAzurePg();
    if (d.handshake.ok && d.server.version) {
      return {
        ok: true as const,
        version: d.server.version,
        extensions: d.server.extensions ?? [],
      };
    }
    const err =
      d.handshake.error?.message ??
      d.tcp.error ??
      d.dns.error ??
      d.connectionString.parseError ??
      "unknown";
    return { ok: false as const, error: err };
  },

  async writeChunk(input: WriteChunkInput) {
    const vec = input.embedding ?? (await embed(input.text));
    const params = [
      input.scope,
      input.agentId ?? null,
      input.text,
      input.source ?? null,
      toPgVector(vec),
      input.metadata ?? {},
      input.authorAgentIds ?? [],
    ];
    const cols = `(scope, agent_id, text, source, embedding, metadata, author_agent_ids)`;
    const vals = `VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`;

    // An exact repeat is a no-op that hands back the row already holding this text. The conflict target
    // is CHUNK_DEDUP_KEY, the same constant the index is built from, so it cannot drift out of sync.
    //
    // FIRST WRITER WINS on `metadata` and `embedding` -- neither is in the DO UPDATE. Today that is
    // unobservable: no caller passes metadata (all five take the `?? {}` default; zero live rows carry
    // any), and a repeat re-embeds the same text. It becomes a data-loss bug the day someone starts
    // passing real metadata, or the embedding model changes and a re-write silently keeps the stale
    // vector. Documented here rather than "fixed" blind, because updating either has its own cost --
    // clobbering an earlier writer's metadata is not obviously better than ignoring a later one's.
    //
    // DO UPDATE, not DO NOTHING: DO NOTHING suppresses the RETURNING row on a conflict, so rows[0]
    // would be undefined on exactly the path this exists to handle. Assigning text to itself is the
    // cheapest touch that still returns the row.
    //
    // created_at is deliberately NOT updated -- the surviving row keeps its ORIGINAL timestamp. Nothing
    // in retrieval ranks on it (searchChunks orders purely by vector distance); the Settings drawer
    // displays it, where "when this was first said" is the honest reading, and it matches the one-off
    // cleanup that preceded this, which kept the oldest row of each duplicate.
    //
    // author_agent_ids IS merged. Dropping the repeat's authors would silently cost them the +0.06
    // author lane boost in auto-retrieval and their name in the [CONTEXT from ...] attribution -- the
    // same memory would stop looking like theirs. Array concat needs no subquery (only sub-SELECTs are
    // forbidden in ON CONFLICT DO UPDATE); the `<@` guard means the common case -- an identical repeat
    // by the same authors -- writes the array back unchanged instead of growing it without bound.
    // Partial overlap can still repeat an id, so attributionSuffix() de-duplicates names on read; the
    // lane boost uses .includes() and is duplicate-insensitive already.
    const onConflict =
      `ON CONFLICT (${CHUNK_DEDUP_KEY})
       DO UPDATE SET text = EXCLUDED.text,
                     author_agent_ids = CASE
                       WHEN EXCLUDED.author_agent_ids <@ rag_chunks.author_agent_ids
                         THEN rag_chunks.author_agent_ids
                       ELSE rag_chunks.author_agent_ids || EXCLUDED.author_agent_ids
                     END`;

    try {
      const { rows } = await q<{ id: string }>(
        `INSERT INTO rag_chunks ${cols} ${vals} ${onConflict} RETURNING id`,
        params,
      );
      return { id: rows[0].id };
    } catch (err) {
      // 42P10 = no unique index matches the conflict target. That is an environment whose bootstrap
      // predates rag_chunks_dedup_idx, NOT a bad write -- and memory writes are fire-and-forget, so a
      // throw here is a SILENT loss of the user's words. Degrade to the historical plain INSERT
      // (duplicates, which is merely the old behaviour) rather than drop the chunk. Any other error
      // is a real failure and still propagates.
      //
      // Read the code off BOTH shapes. q() wraps every driver error in RagStoreUnavailableError, which
      // now lifts `code` off the cause -- but the raw-pg shape is kept as a fallback so this survives a
      // future caller that reaches the pool directly. Testing only the bare `err.code` is what made the
      // first version of this fallback unreachable dead code: the wrapper carried no code at all, the
      // comparison was always true, and the "degrade instead of dropping the chunk" guarantee described
      // right above did not exist. It was never exercised because the live DB has the index.
      const pgCode =
        (err as { code?: string })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode !== "42P10") throw err;
      console.warn(
        "[rag] rag_chunks_dedup_idx missing -- inserting without dedup. Run the memory bootstrap.",
      );
      const { rows } = await q<{ id: string }>(
        `INSERT INTO rag_chunks ${cols} ${vals} RETURNING id`,
        params,
      );
      return { id: rows[0].id };
    }
  },

  async writeTriples(inputs: WriteTripleInput[]) {
    if (inputs.length === 0) return { ids: [] };
    const ids: string[] = [];
    for (const t of inputs) {
      // "researched" mode: supersede any prior LIVE fact with the same (scope, subject, predicate) so
      // retrieval returns only this latest value. Fail-safe: a supersession error never blocks the
      // insert (e.g. if the superseded_at column isn't present yet in some environment).
      if (t.supersede) {
        try {
          await q(
            // `AND lower(object) <> lower($4)` -- supersede means the VALUE CHANGED, and re-asserting a
            // fact identical to the live one is not a change. Without this clause the dominant producer
            // (memoryMode "researched" is the DEFAULT, so supersede is on for almost every write)
            // superseded the live row and inserted a fresh copy every single time, so there was never a
            // live row left to conflict with -- write-time dedup would have been structurally unable to
            // fire on the path that produces the most triples, while quietly growing the superseded
            // chains instead (measured: 8 supersede-chain groups, 20 excess rows, 36% of all excess).
            // Now an unchanged re-assertion leaves the live row alone and falls through to the ON
            // CONFLICT below, which collapses it.
            `UPDATE rag_triples SET superseded_at = now()
             WHERE scope = $1 AND lower(subject) = lower($2) AND lower(predicate) = lower($3)
               AND lower(object) <> lower($4)
               AND superseded_at IS NULL`,
            [t.scope, t.subject, t.predicate, t.object],
          );
        } catch (err) {
          console.warn("[rag] triple supersession skipped:", err);
        }
      }
      // Re-asserting a fact that is already LIVE is not a new fact -- it collapses onto the existing
      // row and returns that row's id. The conflict target repeats TRIPLE_DEDUP_PRED because Postgres
      // cannot infer a PARTIAL index without its predicate; both come from the constants above so the
      // index and this clause cannot drift.
      //
      // This deliberately does NOT interfere with supersede: that path marks prior live rows superseded
      // BEFORE inserting, so by the time this runs there is no live row to conflict with and the insert
      // proceeds normally. Superseded history is outside the index entirely.
      //
      // DO UPDATE rather than DO NOTHING, for a reason that bit the chunks version: DO NOTHING
      // suppresses the RETURNING row on conflict, so rows[0] would be undefined on exactly the path
      // this exists to handle -- and `ids` is what rag.functions.ts reports to the UI as tripleCount,
      // so it would silently undercount too. The SETs are meaningful rather than a no-op touch: keep
      // the HIGHER confidence of the two assertions, and merge authors (guarded with `<@` so an
      // identical repeat writes the array back unchanged instead of growing it). source_chunk_id is
      // left alone -- provenance points at the chunk that FIRST carried the fact.
      const head = `INSERT INTO rag_triples (scope, agent_id, subject, predicate, object, confidence, source_chunk_id, author_agent_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      const tParams = [
        t.scope,
        t.agentId ?? null,
        t.subject,
        t.predicate,
        t.object,
        t.confidence ?? 0.8,
        t.sourceChunkId ?? null,
        t.authorAgentIds ?? [],
      ];
      // created_at IS bumped here, the OPPOSITE of writeChunk -- and the difference is deliberate, not
      // an inconsistency. lookupTriples orders `confidence DESC, created_at DESC`, so for triples
      // created_at is LOAD-BEARING ranking input; searchChunks orders purely by vector distance, so for
      // chunks it is display metadata only. Keeping the original timestamp here would make a fact the
      // user keeps re-asserting rank as though it were the stalest thing in the store.
      const tOnConflict = `ON CONFLICT (${TRIPLE_DEDUP_KEY}) WHERE ${TRIPLE_DEDUP_PRED}
         DO UPDATE SET confidence = greatest(rag_triples.confidence, EXCLUDED.confidence),
                       created_at = now(),
                       author_agent_ids = CASE
                         WHEN EXCLUDED.author_agent_ids <@ rag_triples.author_agent_ids
                           THEN rag_triples.author_agent_ids
                         ELSE rag_triples.author_agent_ids || EXCLUDED.author_agent_ids
                       END`;

      let inserted: { id: string };
      try {
        const { rows } = await q<{ id: string }>(`${head} ${tOnConflict} RETURNING id`, tParams);
        inserted = rows[0];
      } catch (err) {
        // Same fail-safe as writeChunk, and the same reason it must read BOTH error shapes: q() wraps
        // driver errors in RagStoreUnavailableError, which lifts `code` off its cause -- testing only
        // the bare `err.code` is what made the chunks version dead code. 42P10 means this environment's
        // bootstrap predates rag_triples_dedup_idx. Facts are written fire-and-forget alongside chunks,
        // so a throw here silently drops a fact about the user; degrade to the historical plain INSERT
        // (duplicates -- merely the old behaviour) instead. Any other error is real and propagates.
        const pgCode =
          (err as { code?: string })?.code ??
          (err as { cause?: { code?: string } })?.cause?.code;
        if (pgCode !== "42P10") throw err;
        console.warn(
          "[rag] rag_triples_dedup_idx missing -- inserting without dedup. Run the memory bootstrap.",
        );
        const { rows } = await q<{ id: string }>(`${head} RETURNING id`, tParams);
        inserted = rows[0];
      }
      ids.push(inserted.id);
    }
    return { ids };
  },

  async searchChunks(input: SearchChunksInput): Promise<ChunkRow[]> {
    const vec = input.queryVec ?? (await embed(input.query));
    // Clamp stays, but no longer SILENT. A caller asking for more than the ceiling used to be trimmed
    // with no signal, so a retrieval that quietly returned fewer rows than requested was indentical to
    // one that found fewer -- and "the agent didn't remember" is the only symptom either produces.
    const kRequested = input.k ?? 6;
    const k = Math.min(Math.max(kRequested, 1), 20);
    if (kRequested > 20) console.warn(`[rag] searchChunks k=${kRequested} clamped to ${k}`);
    const clause = scopeClause(input.mode, input.scope, input.agentId);
    const params: unknown[] = [toPgVector(vec)];
    const where = clause.sql.replace("$AGENT", `$${params.length + 1}`);
    params.push(...clause.params);
    params.push(k);

    const { rows } = await q(
      `SELECT id, scope, agent_id, text, source, created_at, author_agent_ids,
              1 - (embedding::halfvec(${EMBED_DIM}) <=> ($1::vector)::halfvec(${EMBED_DIM})) AS score
       FROM rag_chunks
       WHERE ${where}
       ORDER BY embedding::halfvec(${EMBED_DIM}) <=> ($1::vector)::halfvec(${EMBED_DIM})
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => {
      const row = r as {
        id: string;
        scope: "agent" | "global";
        agent_id: string | null;
        text: string;
        source: string | null;
        author_agent_ids: string[] | null;
        score: number | string;
        created_at: string;
      };
      return {
        id: row.id,
        scope: row.scope,
        agentId: row.agent_id,
        text: row.text,
        source: row.source,
        authorAgentIds: row.author_agent_ids ?? [],
        score: Number(row.score),
        createdAt: row.created_at,
      };
    });
  },

  async lookupTriples(input: LookupTriplesInput): Promise<TripleRow[]> {
    const k = Math.min(Math.max(input.k ?? 8, 1), 30);
    const clause = scopeClause(input.mode, input.scope, input.agentId);
    const params: unknown[] = [];
    let where = clause.sql;
    if (clause.params.length > 0) {
      where = where.replace("$AGENT", `$${params.length + 1}`);
      params.push(...clause.params);
    }
    if (input.subject) {
      params.push(`%${input.subject}%`);
      where += ` AND subject ILIKE $${params.length}`;
    }
    if (input.predicate) {
      params.push(`%${input.predicate}%`);
      where += ` AND predicate ILIKE $${params.length}`;
    }
    if (input.query) {
      params.push(input.query);
      where += ` AND to_tsvector('english', subject || ' ' || predicate || ' ' || object) @@ plainto_tsquery('english', $${params.length})`;
    }
    // "researched" mode: hide facts a newer same-key fact has superseded (legacy modes leave this off →
    // all triples visible, unchanged). Guarded expression so it's inert if the column doesn't exist yet.
    if (input.excludeSuperseded) {
      where += ` AND superseded_at IS NULL`;
    }
    params.push(k);
    const { rows } = await q(
      `SELECT id, scope, agent_id, subject, predicate, object, confidence, created_at, author_agent_ids
       FROM rag_triples
       WHERE ${where}
       ORDER BY confidence DESC, created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => {
      const row = r as {
        id: string;
        scope: "agent" | "global";
        agent_id: string | null;
        subject: string;
        predicate: string;
        object: string;
        confidence: number | string;
        author_agent_ids: string[] | null;
        created_at: string;
      };
      return {
        id: row.id,
        scope: row.scope,
        agentId: row.agent_id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        confidence: Number(row.confidence),
        authorAgentIds: row.author_agent_ids ?? [],
        createdAt: row.created_at,
      };
    });
  },
};

export interface RoundTripResult {
  ok: boolean;
  steps: {
    bootstrap?: { ok: boolean; error?: string };
    write?: { ok: boolean; id?: string; ms?: number; error?: string };
    semanticSearch?: { ok: boolean; matched?: boolean; topId?: string; topScore?: number; hitCount?: number; ms?: number; error?: string };
    directRead?: { ok: boolean; text?: string; ms?: number; error?: string };
    cleanup?: { ok: boolean; deleted?: number; error?: string };
  };
  marker: string;
  timestamp: string;
}

/**
 * True end-to-end verification. Writes a uniquely-tagged chunk, searches for it
 * semantically, reads it back by id, then deletes it. Every step returns its
 * raw result — no fake "success" states.
 */
export async function verifyRoundTrip(): Promise<RoundTripResult> {
  const marker = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const text = `MEMORY_VERIFY_MARKER ${marker}: Azure Postgres pgvector round-trip probe.`;
  const result: RoundTripResult = { ok: false, steps: {}, marker, timestamp: new Date().toISOString() };

  const boot = await runBootstrap();
  result.steps.bootstrap = { ok: boot.ok, error: boot.error?.message };
  if (!boot.ok) return result;

  let chunkId: string | undefined;
  try {
    const t0 = Date.now();
    const w = await azurePgStore.writeChunk({ scope: "global", text, source: `roundtrip:${marker}` });
    chunkId = w.id;
    result.steps.write = { ok: true, id: w.id, ms: Date.now() - t0 };
  } catch (err) {
    result.steps.write = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return result;
  }

  try {
    const t0 = Date.now();
    const hits = await azurePgStore.searchChunks({ query: text, k: 5, mode: "shared" });
    const top = hits[0];
    result.steps.semanticSearch = {
      ok: true,
      matched: top?.id === chunkId,
      topId: top?.id,
      topScore: top?.score,
      hitCount: hits.length,
      ms: Date.now() - t0,
    };
  } catch (err) {
    result.steps.semanticSearch = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const t0 = Date.now();
    const { rows } = await q<{ text: string }>(`SELECT text FROM rag_chunks WHERE id = $1`, [chunkId]);
    result.steps.directRead = { ok: rows.length === 1, text: rows[0]?.text, ms: Date.now() - t0 };
  } catch (err) {
    result.steps.directRead = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const del = await q<{ id: string }>(`DELETE FROM rag_chunks WHERE id = $1 RETURNING id`, [chunkId]);
    result.steps.cleanup = { ok: true, deleted: del.rows.length };
  } catch (err) {
    result.steps.cleanup = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  result.ok =
    !!result.steps.write?.ok &&
    !!result.steps.semanticSearch?.ok &&
    !!result.steps.semanticSearch?.matched &&
    !!result.steps.directRead?.ok;

  return result;
}

export type { DiagnoseResult };

export interface ListedChunk {
  id: string;
  scope: "agent" | "global";
  agentId: string | null;
  text: string;
  source: string | null;
  createdAt: string;
}

/**
 * List saved memory chunks visible to an agent (its own + global). If no
 * agentId is passed, returns global chunks only.
 */
export async function listChunksForAgent(input: {
  agentId?: string;
  limit?: number;
}): Promise<{ rows: ListedChunk[] }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  let where = `scope = 'global'`;
  if (input.agentId) {
    params.push(input.agentId);
    where = `(scope = 'global' OR (scope = 'agent' AND agent_id = $${params.length}))`;
  }
  params.push(limit);
  const { rows } = await q(
    `SELECT id, scope, agent_id, text, source, created_at
     FROM rag_chunks
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return {
    rows: rows.map((r) => {
      const row = r as {
        id: string;
        scope: "agent" | "global";
        agent_id: string | null;
        text: string;
        source: string | null;
        created_at: string;
      };
      return {
        id: row.id,
        scope: row.scope,
        agentId: row.agent_id,
        text: row.text,
        source: row.source,
        createdAt: row.created_at,
      };
    }),
  };
}

export async function deleteChunkById(id: string): Promise<{ deleted: number }> {
  // Triples reference chunks via ON DELETE SET NULL, so this is safe.
  const { rows } = await q<{ id: string }>(
    `DELETE FROM rag_chunks WHERE id = $1 RETURNING id`,
    [id],
  );
  return { deleted: rows.length };
}

