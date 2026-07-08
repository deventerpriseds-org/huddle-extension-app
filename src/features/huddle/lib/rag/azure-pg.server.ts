// Azure Postgres + pgvector implementation of RagStore. Uses `pg` over TCP.
// AZURE_PG_URL is a full connection string (postgresql://user:pass@host:5432/db?sslmode=require).

import { Pool } from "pg";
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

let _pool: Pool | null = null;
let _bootstrapped = false;

function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
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

const BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

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

-- HNSW has a 2000-dim cap; text-embedding-3-large is 3072. Use ivfflat instead.
CREATE INDEX IF NOT EXISTS rag_chunks_embed_ivf
  ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS rag_chunks_agent_idx
  ON rag_chunks (agent_id) WHERE scope = 'agent';
CREATE INDEX IF NOT EXISTS rag_chunks_authors_idx
  ON rag_chunks USING gin (author_agent_ids);

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

CREATE INDEX IF NOT EXISTS rag_triples_subject_idx ON rag_triples (subject);
CREATE INDEX IF NOT EXISTS rag_triples_fts_idx
  ON rag_triples USING gin (to_tsvector('english', subject || ' ' || predicate || ' ' || object));
CREATE INDEX IF NOT EXISTS rag_triples_authors_idx
  ON rag_triples USING gin (author_agent_ids);
`;

async function ensureBootstrap(): Promise<void> {
  if (_bootstrapped) return;
  const pool = getPool();
  await pool.query(BOOTSTRAP_SQL);
  _bootstrapped = true;
}

/**
 * Compose the WHERE fragment for scope filtering based on the caller's sharing mode.
 * - "shared" (default): global rows + this agent's private rows.
 * - "private": only this agent's private rows (never sees other agents' shared writes).
 * - "readonly-shared": globals only, never own private rows.
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
  // shared (or unspecified): explicit scope override still wins
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
    await ensureBootstrap();
  },

  async ping() {
    try {
      const pool = getPool();
      await ensureBootstrap();
      const ver = await pool.query<{ version: string }>("SELECT version()");
      const ext = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension ORDER BY extname",
      );
      return {
        ok: true as const,
        version: ver.rows[0]?.version ?? "unknown",
        extensions: ext.rows.map((r) => r.extname),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async writeChunk(input: WriteChunkInput) {
    await ensureBootstrap();
    const pool = getPool();
    const vec = input.embedding ?? (await embed(input.text));
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO rag_chunks (scope, agent_id, text, source, embedding, metadata, author_agent_ids)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
       RETURNING id`,
      [
        input.scope,
        input.agentId ?? null,
        input.text,
        input.source ?? null,
        toPgVector(vec),
        input.metadata ?? {},
        input.authorAgentIds ?? [],
      ],
    );
    return { id: rows[0].id };
  },

  async writeTriples(inputs: WriteTripleInput[]) {
    if (inputs.length === 0) return { ids: [] };
    await ensureBootstrap();
    const pool = getPool();
    const ids: string[] = [];
    for (const t of inputs) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO rag_triples (scope, agent_id, subject, predicate, object, confidence, source_chunk_id, author_agent_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          t.scope,
          t.agentId ?? null,
          t.subject,
          t.predicate,
          t.object,
          t.confidence ?? 0.8,
          t.sourceChunkId ?? null,
          t.authorAgentIds ?? [],
        ],
      );
      ids.push(rows[0].id);
    }
    return { ids };
  },

  async searchChunks(input: SearchChunksInput): Promise<ChunkRow[]> {
    await ensureBootstrap();
    const pool = getPool();
    const vec = await embed(input.query);
    const k = Math.min(Math.max(input.k ?? 6, 1), 20);

    const clause = scopeClause(input.mode, input.scope, input.agentId);
    const params: unknown[] = [toPgVector(vec)];
    const where = clause.sql.replace("$AGENT", `$${params.length + 1}`);
    params.push(...clause.params);
    params.push(k);

    const { rows } = await pool.query(
      `SELECT id, scope, agent_id, text, source, created_at, author_agent_ids,
              1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks
       WHERE ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      agentId: r.agent_id,
      text: r.text,
      source: r.source,
      authorAgentIds: (r.author_agent_ids ?? []) as string[],
      score: Number(r.score),
      createdAt: r.created_at,
    }));
  },

  async lookupTriples(input: LookupTriplesInput): Promise<TripleRow[]> {
    await ensureBootstrap();
    const pool = getPool();
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

    params.push(k);
    const { rows } = await pool.query(
      `SELECT id, scope, agent_id, subject, predicate, object, confidence, created_at, author_agent_ids
       FROM rag_triples
       WHERE ${where}
       ORDER BY confidence DESC, created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      agentId: r.agent_id,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: Number(r.confidence),
      authorAgentIds: (r.author_agent_ids ?? []) as string[],
      createdAt: r.created_at,
    }));
  },
};
