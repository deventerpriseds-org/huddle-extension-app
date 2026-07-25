// Metadata store for the artifact workspace, in the pinned Azure PG (eds-postgresql / RAG_AI_Agents),
// schema `artifacts`. Bytes live in Blob Storage (blob.server.ts); this table is the index the UI reads.
// Every read/write is scoped by user_email so one user can never see another's artifacts or SAS URLs.
// Auto-bootstraps its schema on first use (same lazy pattern as tasks.server.ts / identity.server.ts).
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { putArtifactBlob, artifactSasUrl, artifactBlobSize } from "./blob.server";

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

export const ARTIFACT_STATUSES = ["review", "approved", "changes", "draft"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS artifacts;
CREATE TABLE IF NOT EXISTS artifacts.items (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL,
  agent_id     TEXT,
  task_id      TEXT,
  folder       TEXT NOT NULL DEFAULT 'Personal',
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  blob_path    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','approved','changes','draft')),
  version      INTEGER NOT NULL DEFAULT 1,
  review_note  TEXT,
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ,
  onedrive_url TEXT,
  gdrive_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_items_user_idx   ON artifacts.items (lower(user_email), created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_items_status_idx ON artifacts.items (lower(user_email), status);
CREATE INDEX IF NOT EXISTS artifact_items_folder_idx ON artifacts.items (lower(user_email), folder);
`;

let _ready: Promise<void> | null = null;
function ensureBootstrapped(): Promise<void> {
  if (!_ready) _ready = getPool().query(BOOTSTRAP_SQL).then(() => undefined);
  return _ready;
}

export interface ArtifactRow {
  id: string;
  user_email: string;
  agent_id: string | null;
  task_id: string | null;
  folder: string;
  name: string;
  mime: string;
  size_bytes: number;
  blob_path: string;
  status: ArtifactStatus;
  version: number;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  onedrive_url: string | null;
  gdrive_url: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id,user_email,agent_id,task_id,folder,name,mime,size_bytes,blob_path,status,version,review_note,reviewed_by,reviewed_at,onedrive_url,gdrive_url,created_at,updated_at";

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "x";
}

export interface CreateArtifactInput {
  userEmail: string;
  agentId?: string | null;
  taskId?: string | null;
  folder: string;
  name: string;
  mime: string;
  bytes: Buffer | Uint8Array;
}

/**
 * Upload the bytes to Blob Storage AND insert the metadata row in one call. Returns the id and the
 * in-app deep link. The blob path is id-keyed so it's unique and safe to overwrite on retry.
 */
export async function createArtifact(input: CreateArtifactInput): Promise<{ id: string; deepLink: string }> {
  await ensureBootstrapped();
  const id = `art-${randomUUID()}`;
  const data = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const blobPath = `${slug(input.userEmail)}/${slug(input.folder)}/${id}-${slug(input.name)}`;
  // Blob first: if the upload fails we never leave a metadata row pointing at nothing.
  await putArtifactBlob(blobPath, data, input.mime);
  await getPool().query(
    `INSERT INTO artifacts.items (id,user_email,agent_id,task_id,folder,name,mime,size_bytes,blob_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.userEmail.toLowerCase(),
      input.agentId ?? null,
      input.taskId ?? null,
      input.folder,
      input.name,
      input.mime,
      data.length,
      blobPath,
    ],
  );
  return { id, deepLink: `/artifacts/${id}` };
}

export interface ArtifactFilters {
  folder?: string;
  status?: ArtifactStatus;
  agentId?: string;
  taskId?: string;
}

/** All of a user's artifacts (newest first), narrowed by any combination of filters. Scoped by email. */
export async function listArtifacts(userEmail: string, f: ArtifactFilters = {}): Promise<ArtifactRow[]> {
  await ensureBootstrapped();
  const params: unknown[] = [userEmail.toLowerCase()];
  let sql = `SELECT ${SELECT_COLS} FROM artifacts.items WHERE lower(user_email) = $1`;
  if (f.folder) { params.push(f.folder); sql += ` AND folder = $${params.length}`; }
  if (f.status) { params.push(f.status); sql += ` AND status = $${params.length}`; }
  if (f.agentId) { params.push(f.agentId); sql += ` AND agent_id = $${params.length}`; }
  if (f.taskId) { params.push(f.taskId); sql += ` AND task_id = $${params.length}`; }
  sql += ` ORDER BY updated_at DESC LIMIT 500`;
  const { rows } = await getPool().query<ArtifactRow>(sql, params);
  return rows;
}

/** One artifact (scoped by email — a wrong owner gets null, so no cross-user read / SAS leak) + a fresh SAS url. */
export async function getArtifact(
  userEmail: string,
  id: string,
): Promise<(ArtifactRow & { url: string | null; blob_size: number | null }) | null> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<ArtifactRow>(
    `SELECT ${SELECT_COLS} FROM artifacts.items WHERE id = $1 AND lower(user_email) = $2`,
    [id, userEmail.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  let url: string | null = null;
  try {
    url = artifactSasUrl(row.blob_path);
  } catch {
    url = null; // storage misconfigured — metadata still returns, UI shows no preview
  }
  const blob_size = await artifactBlobSize(row.blob_path);
  return { ...row, url, blob_size };
}

/**
 * Set an artifact's review status (scoped by email). For a reviewer action ('approved'/'changes') the
 * reviewer identity + timestamp are recorded so ACT-5 can later gate an agent on the approval. Returns
 * the updated row, or null if the id doesn't belong to this user.
 */
export async function setArtifactStatus(
  userEmail: string,
  id: string,
  status: ArtifactStatus,
  note: string | null,
  reviewer: string,
): Promise<ArtifactRow | null> {
  await ensureBootstrapped();
  const isReview = status === "approved" || status === "changes";
  const { rows } = await getPool().query<ArtifactRow>(
    `UPDATE artifacts.items
        SET status = $3,
            review_note = COALESCE($4, review_note),
            reviewed_by = CASE WHEN $5 THEN $6 ELSE reviewed_by END,
            reviewed_at = CASE WHEN $5 THEN now() ELSE reviewed_at END,
            updated_at = now()
      WHERE id = $1 AND lower(user_email) = $2
      RETURNING ${SELECT_COLS}`,
    [id, userEmail.toLowerCase(), status, note, isReview, reviewer.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** Distinct folders a user has artifacts in (for the tree), with counts. */
export async function listArtifactFolders(userEmail: string): Promise<{ folder: string; n: number }[]> {
  await ensureBootstrapped();
  const { rows } = await getPool().query<{ folder: string; n: number }>(
    `SELECT folder, count(*)::int AS n FROM artifacts.items WHERE lower(user_email) = $1 GROUP BY folder ORDER BY folder`,
    [userEmail.toLowerCase()],
  );
  return rows;
}
