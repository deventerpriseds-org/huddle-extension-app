// Metadata store for the artifact workspace, in the pinned Azure PG (eds-postgresql / RAG_AI_Agents),
// schema `artifacts`. Bytes live in Blob Storage (blob.server.ts); this table is the index the UI reads.
// Every read/write is scoped by user_email so one user can never see another's artifacts or SAS URLs.
// Auto-bootstraps its schema on first use (same lazy pattern as tasks.server.ts / identity.server.ts).
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { putArtifactBlob, artifactSasUrl, artifactBlobSize, getArtifactBlobBytes, deleteArtifactBlob } from "./blob.server";

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
-- Identity unification: key on the stable user_id (entra_object_id) with user_email retained as a
-- fallback + display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a
-- user's emails converge to one set of rows regardless of which email a caller presents.
ALTER TABLE artifacts.items ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS artifact_items_userid_idx ON artifacts.items(user_id);

-- Per-user artifact-mirroring preferences (one-way Azure → cloud drives). Defaults ON so approving an
-- artifact mirrors it to OneDrive out of the box; each destination + the on-approve trigger are toggles.
CREATE TABLE IF NOT EXISTS artifacts.mirror_config (
  user_email       TEXT PRIMARY KEY,
  mirror_on_approve BOOLEAN NOT NULL DEFAULT true,
  onedrive_enabled  BOOLEAN NOT NULL DEFAULT true,
  gdrive_enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE artifacts.mirror_config ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS artifact_mirror_config_userid_idx ON artifacts.mirror_config(user_id);
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
  // Optional initial review status. Agent-produced deliverables use the column default 'review'
  // (needs the user's sign-off); a USER-uploaded chat attachment passes 'approved' so it never shows
  // up in the review queue — it's an input, not a deliverable to review (ACT-45).
  status?: ArtifactStatus;
}

/**
 * Upload the bytes to Blob Storage AND insert the metadata row in one call. Returns the id and the
 * in-app deep link. The blob path is id-keyed so it's unique and safe to overwrite on retry.
 */
export async function createArtifact(input: CreateArtifactInput): Promise<{ id: string; deepLink: string }> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId } = await resolveScopeByEmail(input.userEmail);
  const id = `art-${randomUUID()}`;
  const data = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const blobPath = `${slug(input.userEmail)}/${slug(input.folder)}/${id}-${slug(input.name)}`;
  // Blob first: if the upload fails we never leave a metadata row pointing at nothing.
  await putArtifactBlob(blobPath, data, input.mime);
  await getPool().query(
    `INSERT INTO artifacts.items (id,user_email,agent_id,task_id,folder,name,mime,size_bytes,blob_path,status,user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'review'),$11)`,
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
      input.status ?? null,
      userId,
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
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  // Dual-read: prefer rows keyed on the resolved user_id, falling back to any email alias for an
  // un-migrated (user_id NULL) row — so both of a user's emails resolve to the SAME artifacts. The
  // `user_id IS NULL` guard keeps a migrated row from also matching the email branch (no double-return).
  const params: unknown[] = userId ? [userId, emails] : [userEmail.toLowerCase()];
  let sql = `SELECT ${SELECT_COLS} FROM artifacts.items WHERE ${
    userId
      ? "(user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2)))"
      : "lower(user_email) = $1"
  }`;
  if (f.folder) { params.push(f.folder); sql += ` AND folder = $${params.length}`; }
  if (f.status) { params.push(f.status); sql += ` AND status = $${params.length}`; }
  if (f.agentId) { params.push(f.agentId); sql += ` AND agent_id = $${params.length}`; }
  if (f.taskId) { params.push(f.taskId); sql += ` AND task_id = $${params.length}`; }
  sql += ` ORDER BY updated_at DESC LIMIT 500`;
  const { rows } = await getPool().query<ArtifactRow>(sql, params);
  return rows;
}

// Mime families the preview pane renders as text. Kept in sync with ArtifactsView.tsx's preview branch.
const TEXT_PREVIEW_MIME = /^(text\/|application\/json|application\/csv)/;
// Above this, skip the server-side text read (still get a working download link) — a preview pane
// isn't the place to pull multi-MB files into memory on every open.
const TEXT_PREVIEW_MAX_BYTES = 2_000_000;

/** One artifact (scoped by email — a wrong owner gets null, so no cross-user read / SAS leak) + a fresh SAS url. */
export async function getArtifact(
  userEmail: string,
  id: string,
): Promise<(ArtifactRow & { url: string | null; blob_size: number | null; text: string | null }) | null> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const { rows } = await getPool().query<ArtifactRow>(
    userId
      ? `SELECT ${SELECT_COLS} FROM artifacts.items
          WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND lower(user_email) = ANY($3)))
          ORDER BY (user_id IS NOT NULL) DESC LIMIT 1`
      : `SELECT ${SELECT_COLS} FROM artifacts.items WHERE id = $1 AND lower(user_email) = $2`,
    userId ? [id, userId, emails] : [id, userEmail.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  let url: string | null = null;
  try {
    url = await artifactSasUrl(row.blob_path);
  } catch {
    url = null; // storage misconfigured — metadata still returns, UI shows no preview
  }
  const blob_size = await artifactBlobSize(row.blob_path);
  // Read the text server-side (not via the client fetching the SAS url) — the storage account has no
  // CORS rule for the app's origin, so a browser-side fetch() of the SAS URL is silently blocked while
  // <img>/<iframe> loads of the same URL work fine (they aren't CORS-checked). Reading here sidesteps
  // that entirely: this is a normal server-to-server Blob SDK call, no browser CORS involved.
  let text: string | null = null;
  if (TEXT_PREVIEW_MIME.test(row.mime) && (blob_size ?? 0) > 0 && (blob_size ?? 0) <= TEXT_PREVIEW_MAX_BYTES) {
    const bytes = await getArtifactBlobBytes(row.blob_path);
    if (bytes) text = bytes.toString("utf8").slice(0, 20_000);
  }
  return { ...row, url, blob_size, text };
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
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const isReview = status === "approved" || status === "changes";
  // Dual-read predicate (matches a row by user_id OR, for an un-migrated row, by any email alias) so the
  // status change resolves the same row regardless of which email the caller presents. `emails` always
  // contains the passed email, so this is correct even when userId is null. The row self-migrates onto
  // user_id via COALESCE($2, user_id) on any status change once the id is resolvable.
  const { rows } = await getPool().query<ArtifactRow>(
    `UPDATE artifacts.items
        SET status = $4,
            review_note = COALESCE($5, review_note),
            reviewed_by = CASE WHEN $6 THEN $7 ELSE reviewed_by END,
            reviewed_at = CASE WHEN $6 THEN now() ELSE reviewed_at END,
            user_id = COALESCE($2, user_id),
            updated_at = now()
      WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND lower(user_email) = ANY($3)))
      RETURNING ${SELECT_COLS}`,
    [id, userId, emails, status, note, isReview, reviewer.toLowerCase()],
  );
  return rows[0] ?? null;
}

/**
 * Delete an artifact (metadata row + its blob), scoped by email. Deletes the blob first so a failure
 * never orphans bytes with no index row; the row delete is authoritative for "gone". Returns the number
 * of rows removed (0 = wrong owner or already gone — idempotent, never throws on a missing id).
 */
export async function deleteArtifact(userEmail: string, id: string): Promise<{ deleted: number; error?: string }> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  // Dual-read ownership predicate (user_id OR any email alias for an un-migrated row). `emails` always
  // contains the passed email so it's correct when userId is null too. The DELETE below reuses the SAME
  // predicate so a row matched via user_id (created under a different alias) is actually removed rather
  // than leaving an orphaned row after its blob was already deleted.
  const { rows } = await getPool().query<{ blob_path: string }>(
    `SELECT blob_path FROM artifacts.items
       WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND lower(user_email) = ANY($3)))
       ORDER BY (user_id IS NOT NULL) DESC LIMIT 1`,
    [id, userId, emails],
  );
  const row = rows[0];
  if (!row) return { deleted: 0 }; // wrong owner or missing — no cross-user delete
  // Blob first: if it can't be removed (a transient storage error, not a 404 — deleteIfExists swallows
  // those), KEEP the row so the artifact stays listed as the handle to retry, rather than orphaning bytes.
  const blobOk = await deleteArtifactBlob(row.blob_path);
  if (!blobOk) return { deleted: 0, error: "Couldn't remove the stored file — the artifact was kept so you can retry." };
  const res = await getPool().query(
    `DELETE FROM artifacts.items
       WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND lower(user_email) = ANY($3)))`,
    [id, userId, emails],
  );
  return { deleted: res.rowCount ?? 0 };
}

/** Distinct folders a user has artifacts in (for the tree), with counts. */
export async function listArtifactFolders(userEmail: string): Promise<{ folder: string; n: number }[]> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const { rows } = await getPool().query<{ folder: string; n: number }>(
    userId
      ? `SELECT folder, count(*)::int AS n FROM artifacts.items
          WHERE (user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2)))
          GROUP BY folder ORDER BY folder`
      : `SELECT folder, count(*)::int AS n FROM artifacts.items WHERE lower(user_email) = $1 GROUP BY folder ORDER BY folder`,
    userId ? [userId, emails] : [userEmail.toLowerCase()],
  );
  return rows;
}

// ---- Mirroring (one-way Azure → cloud drives) -----------------------------------------------------

export interface MirrorConfig {
  mirror_on_approve: boolean;
  onedrive_enabled: boolean;
  gdrive_enabled: boolean;
}
const MIRROR_DEFAULTS: MirrorConfig = { mirror_on_approve: true, onedrive_enabled: true, gdrive_enabled: true };

/** A user's mirror preferences, defaulting all-on when they've never set them. */
export async function getMirrorConfig(userEmail: string): Promise<MirrorConfig> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const { rows } = await getPool().query<MirrorConfig>(
    userId
      ? `SELECT mirror_on_approve, onedrive_enabled, gdrive_enabled FROM artifacts.mirror_config
          WHERE user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2))
          ORDER BY (user_id IS NOT NULL) DESC, updated_at DESC LIMIT 1`
      : `SELECT mirror_on_approve, onedrive_enabled, gdrive_enabled FROM artifacts.mirror_config WHERE lower(user_email) = $1 LIMIT 1`,
    userId ? [userId, emails] : [userEmail.toLowerCase()],
  );
  return rows[0] ?? { ...MIRROR_DEFAULTS };
}

/** Persist the WHOLE config (no partial-update surprises). Idempotent upsert keyed by email. */
export async function setMirrorConfig(userEmail: string, cfg: MirrorConfig): Promise<MirrorConfig> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId } = await resolveScopeByEmail(userEmail);
  // Upsert stays on the user_email PK (stable per user); user_id is set/refreshed when resolvable and
  // never nulled out once present (COALESCE keeps the existing value on a userId-less write).
  await getPool().query(
    `INSERT INTO artifacts.mirror_config (user_email, mirror_on_approve, onedrive_enabled, gdrive_enabled, user_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (user_email) DO UPDATE SET
       mirror_on_approve = EXCLUDED.mirror_on_approve,
       onedrive_enabled  = EXCLUDED.onedrive_enabled,
       gdrive_enabled    = EXCLUDED.gdrive_enabled,
       user_id = COALESCE(EXCLUDED.user_id, artifacts.mirror_config.user_id),
       updated_at = now()`,
    [userEmail.toLowerCase(), cfg.mirror_on_approve, cfg.onedrive_enabled, cfg.gdrive_enabled, userId],
  );
  return cfg;
}

export interface MirrorResult { ok: boolean; onedrive_url?: string | null; error?: string; needsConsent?: boolean }

/**
 * Mirror one artifact's bytes to the owner's OneDrive and persist the returned webUrl in onedrive_url.
 * Scoped by email (a wrong owner is a no-op). Never throws — returns a result the caller surfaces.
 */
export async function mirrorArtifactToOneDrive(userEmail: string, id: string): Promise<MirrorResult> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { userId, emails } = await resolveScopeByEmail(userEmail);
  const { rows } = await getPool().query<ArtifactRow>(
    userId
      ? `SELECT ${SELECT_COLS} FROM artifacts.items
          WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND lower(user_email) = ANY($3)))
          ORDER BY (user_id IS NOT NULL) DESC LIMIT 1`
      : `SELECT ${SELECT_COLS} FROM artifacts.items WHERE id = $1 AND lower(user_email) = $2`,
    userId ? [id, userId, emails] : [id, userEmail.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "Not found." };
  const bytes = await getArtifactBlobBytes(row.blob_path);
  if (!bytes) return { ok: false, error: "Artifact bytes not found in storage." };
  const { uploadArtifactToOneDrive } = await import("./onedrive.server");
  const r = await uploadArtifactToOneDrive({ mailbox: row.user_email, lane: row.folder, name: row.name, bytes, mime: row.mime });
  if (!r.ok) return { ok: false, error: r.error, needsConsent: r.needsConsent };
  await getPool().query(`UPDATE artifacts.items SET onedrive_url = $2, updated_at = now() WHERE id = $1`, [id, r.webUrl ?? null]);
  return { ok: true, onedrive_url: r.webUrl ?? null };
}
