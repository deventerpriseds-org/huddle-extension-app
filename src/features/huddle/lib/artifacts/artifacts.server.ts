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
  // SANITISE HERE, not only at the agent choke point. `createArtifact` is the LAST gate before
  // anything is persisted, and it has five callers — the agent tool, the durable-turn path, the
  // artifacts panel, and USER-UPLOADED chat attachments, whose filename is just as untrusted as model
  // output. Both helpers are idempotent, so the upstream call in createArtifactFromAgent (which needs
  // the safe name to resolve an extension) is unaffected. Loop 2 fixed `name` at one site and left
  // `folder` and four other callers open; putting it here is what makes it a guard rather than a patch.
  const folder = safeArtifactFolder(input.folder);
  const name = safeArtifactName(input.name);
  const blobPath = `${slug(input.userEmail)}/${slug(folder)}/${id}-${slug(name)}`;
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
      folder,
      name,
      input.mime,
      data.length,
      blobPath,
      input.status ?? null,
      userId,
    ],
  );
  return { id, deepLink: `/artifacts/${id}` };
}

/** Longest filename we will store. SharePoint/OneDrive reject a full path over ~400 characters, and
 *  the mirror path already spends some of that on "Huddle Artifacts/{lane}/". A 5005-character name
 *  passed through `safeArtifactName` untouched before this cap — found by verifier loop 3, which also
 *  noted that a name too long to mirror fails at Graph, far from where it was accepted. */
const MAX_ARTIFACT_NAME = 120;

/** Truncate the STEM, never the extension — "…verylong.docx" must stay openable as a Word file. */
function capLength(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  // Only treat a trailing dot-segment as an extension when it looks like one (short, no spaces).
  const ext = dot > 0 && name.length - dot <= 10 && !/\s/.test(name.slice(dot)) ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  return stem.slice(0, Math.max(1, max - ext.length)) + ext;
}

/**
 * Strip any path out of a model-supplied artifact name, leaving a bare filename.
 *
 * THIS IS A PATH-TRAVERSAL FIX, NOT TIDYING. `slug()` protected the BLOB path but nothing sanitised
 * `artifacts.items.name`, and the OneDrive mirror builds its upload path from that name with
 * `encodeURIComponent` per segment — which does NOT encode `.` — so a name of `../../etc/passwd`
 * escaped the "Huddle Artifacts" folder on mirror. Outward-facing, on a real user's drive, driven by
 * model output. Found by the verifier (onedrive.server.ts:21).
 *
 * Keeps only the last path segment, drops `..`, and refuses a name that is nothing but an extension
 * (".docx" → "artifact.docx") so the file is always addressable.
 */
export function safeArtifactName(name: string): string {
  const raw = String(name ?? "").replace(/\\/g, "/");
  const last = raw.split("/").filter((seg) => seg && seg !== "." && seg !== "..").pop() ?? "";
  // Control characters and the characters Windows/OneDrive reject outright.
  const cleaned = last.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "artifact";
  // A bare extension (".docx") has no stem to address — give it one.
  return capLength(cleaned.startsWith(".") ? `artifact${cleaned}` : cleaned, MAX_ARTIFACT_NAME);
}

/**
 * The filename this artifact takes in the owner's OneDrive.
 *
 * WHY IT IS NOT JUST `name`. The mirror is deliberately path-keyed — `Huddle Artifacts/{lane}/{name}`
 * with replace semantics — so re-mirroring the SAME artifact overwrites its own item instead of
 * piling up duplicates. That property depends on the path being unique PER ARTIFACT, and
 * `safeArtifactName` broke it in a way that only shows up after the traversal fix: `reports/q3.docx`
 * and `drafts/q3.docx` are two different artifacts that now both sanitise to `q3.docx`, land in the
 * same lane, and silently overwrite each other on the user's real drive. Losing an approved
 * deliverable to a name collision is worse than the traversal it came from.
 *
 * So the stem carries the artifact id's short suffix: unique per artifact, STABLE across re-mirrors
 * (the id never changes), and still readable — `Q3 plan (1a2b3c4d).docx`.
 */
export function mirrorFileName(id: string, name: string): string {
  const safe = safeArtifactName(name);
  const short = String(id ?? "").replace(/^art-/, "").replace(/-/g, "").slice(0, 8) || "unknown";
  if (safe.includes(`(${short})`)) return safe;
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 && safe.length - dot <= 10 && !/\s/.test(safe.slice(dot)) ? safe.slice(dot) : "";
  const stem = ext ? safe.slice(0, dot) : safe;
  const suffix = ` (${short})`;
  return capLength(stem, MAX_ARTIFACT_NAME - suffix.length - ext.length) + suffix + ext;
}

/**
 * The LANE half of the same traversal fix. `safeArtifactName` closed `{name}` in
 * `Huddle Artifacts/{lane}/{name}` and left `{lane}` open — and `folder` is just as model-driven as
 * `name` was, so `create_artifact({folder:"../../../Documents"})` reproduced the identical escape on
 * a real user's OneDrive. `encodeURIComponent` does not encode ".", so `..` segments survive into the
 * Graph URL. Found by the independent verifier (VERIFY-artifact-formats-3.md, R2).
 *
 * A lane is ONE segment by construction, so this collapses to the last real segment and drops any
 * `.`/`..`. Falls back to "Personal" — the same default the `artifacts.items` DDL uses — so an
 * artifact is never stranded in an unaddressable folder.
 *
 * TWO LANES WROTE THIS FUNCTION INDEPENDENTLY off the same verifier finding, and git auto-merged
 * both into this module with NO conflict — a duplicate `export function` that only `tsc` would have
 * caught. This body is the survivor because its fallback is grounded in the DDL default above rather
 * than picked; the other collapsed nested segments with a dash instead of taking the last, which is
 * a coin-flip either way. Worth remembering that a clean auto-merge is not a correct merge.
 *
 * The lesson the finding itself carries: loop 2 sanitised `name` and never asked what ELSE feeds
 * that path. Fixing the input that was named instead of the class is what this repo's "systematic
 * capability, never a patch" rule warns about, and it cost a whole verification loop.
 */
export function safeArtifactFolder(folder: string): string {
  const raw = String(folder ?? "").replace(/\\/g, "/");
  const last = raw.split("/").filter((seg) => seg && seg !== "." && seg !== "..").pop() ?? "";
  const cleaned = last.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "Personal";
  return cleaned;
}

/** Give `name` this exact extension, replacing a document extension it already carries rather than
 *  appending to it — "flow.md" + ".mmd" is "flow.mmd", never "flow.md.mmd". Mirrors the rule in
 *  render.server's `ensureExtension`, which cannot be reused here because it keys off a FORMAT it
 *  knows and these two extensions belong to the tool's vocabulary instead. */
export function withExtension(name: string, ext: string): string {
  const base = String(name ?? "").trim() || "artifact";
  if (base.toLowerCase().endsWith(ext)) return base;
  const replaceable = [".md", ".markdown", ".txt", ".html", ".htm", ".docx", ".pptx", ".mmd", ".svg"];
  for (const r of replaceable) {
    if (base.toLowerCase().endsWith(r)) return base.slice(0, base.length - r.length) + ext;
  }
  return base + ext;
}

/**
 * THE ONE PLACE a `create_artifact` tool call becomes a stored artifact.
 *
 * WHY THIS EXISTS RATHER THAN FOUR COPIES: the same six lines were repeated at four dispatch sites
 * (huddle.functions.ts x3 — the OpenAI path, the Lovable path and the durable-turn path — plus
 * voice/realtime-tools.server.ts), each hardcoding `Buffer.from(content, "utf8")` and
 * `mime ?? "text/markdown"`. Adding Word/PowerPoint by editing all four is how one path silently
 * keeps producing markdown forever. Every site now calls THIS, so a new format is one edit.
 *
 * Renders first (`format` decides), then stores. `renderArtifact` never throws: a malformed
 * structure or unparseable markdown degrades to a valid document carrying the raw text plus a
 * warning, so an agent's mistake costs fidelity, never the user's work.
 */
export async function createArtifactFromAgent(input: {
  userEmail: string;
  agentId?: string | null;
  taskId?: string | null;
  folder: string;
  name: string;
  /** Raw tool arguments, unvalidated — this is model output. */
  args: { format?: unknown; content?: unknown; document?: unknown; mime?: unknown };
}): Promise<{ id: string; deepLink: string; name: string; mime: string; warnings: string[] }> {
  const { renderArtifact } = await import("./render.server");
  const a = input.args;
  // Trim whitespace and casing before matching: the verifier landed `" DOCX "` here.
  const format = typeof a.format === "string" ? a.format.trim().toLowerCase() : "md";
  // Sanitise ONCE, at the choke point, so every downstream consumer (blob path, DB row, OneDrive
  // mirror) gets the same safe name. See safeArtifactName — this is the path-traversal fix.
  const safeName = safeArtifactName(input.name);
  // Same reasoning, the other half of the mirror path — see safeArtifactFolder.
  const safeFolder = safeArtifactFolder(input.folder);

  // FORMATS THE TOOL OFFERS THAT THE RENDERER DOES NOT KNOW.
  // `render.server` handles md | html | docx | pptx and degrades anything else to markdown — correct
  // for it, wrong here: `create_artifact` also offers `mermaid` and `svg`, and an end-to-end check
  // caught both arriving as `name.md` + text/markdown, which the viewer can never render as a
  // diagram or a vector. They are PASSTHROUGH TEXT like html, so they need no renderer — only the
  // right extension and mime, which is a dispatch concern, not a rendering one. Keeping this at the
  // boundary is also what stops the renderer growing a case per tool vocabulary word.
  const PASSTHROUGH: Record<string, { ext: string; mime: string }> = {
    mermaid: { ext: ".mmd", mime: "text/vnd.mermaid; charset=utf-8" },
    svg: { ext: ".svg", mime: "image/svg+xml; charset=utf-8" },
  };
  const passthrough = PASSTHROUGH[format];
  if (passthrough) {
    const body = typeof a.content === "string" ? a.content : "";
    // NOT render.server's `ensureExtension` — that takes a FORMAT and looks it up in its own
    // EXTENSION_BY_FORMAT, which has no entry for mermaid or svg, so it returned `name + undefined`
    // ("security-optionsundefined"). Caught by the dispatch suite the moment it was written. These
    // two extensions belong to the TOOL's vocabulary, not the renderer's, so they are resolved here.
    const outName = withExtension(safeName, passthrough.ext);
    const { id, deepLink } = await createArtifact({
      userEmail: input.userEmail,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      folder: safeFolder,
      name: outName,
      mime: passthrough.mime,
      bytes: Buffer.from(body, "utf8"),
    });
    return {
      id,
      deepLink,
      name: outName,
      mime: passthrough.mime,
      warnings: body.trim() ? [] : [`Empty ${format} content — the artifact will render blank.`],
    };
  }

  const rendered = await renderArtifact({
    format,
    content: typeof a.content === "string" ? a.content : undefined,
    document: a.document,
    name: safeName,
  });

  // An explicit `mime` is the documented escape hatch for a type `format` does not cover — but it
  // must never make an artifact LIE ABOUT ITSELF, in either direction.
  //
  // The first version of this guard only checked the direction I had thought of: it tested
  // `rendered.mime` to stop a real docx being labelled text/markdown (that works). The verifier
  // found the REVERSE wide open — `{format:"md", mime:"…wordprocessingml.document"}` stored three
  // bytes of markdown (`23 20 52`, not the `50 4b 03 04` of a ZIP) under the Word mime, so the user
  // downloads "report.docx" and Word refuses to open it. A one-sided guard on a two-sided problem.
  //
  // So: an override is honoured only when BOTH sides are non-package types. Claiming to be an Office
  // document is reserved for bytes that actually are one.
  const rawMime = typeof a.mime === "string" && a.mime.trim() ? a.mime.trim() : null;
  const isPackageMime = (m: string) =>
    /officedocument|application\/zip|application\/pdf|^application\/octet-stream/i.test(m);
  const mime =
    rawMime && !isPackageMime(rendered.mime) && !isPackageMime(rawMime) ? rawMime : rendered.mime;

  const { id, deepLink } = await createArtifact({
    userEmail: input.userEmail,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    folder: safeFolder,
    name: rendered.name,
    mime,
    bytes: rendered.bytes,
  });
  return { id, deepLink, name: rendered.name, mime, warnings: rendered.warnings ?? [] };
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
/** Which mimes get their BYTES returned for in-app preview.
 *
 *  THE VIEWER CANNOT RENDER WHAT THE SERVER NEVER SENDS. `text/html` and `text/vnd.mermaid` already
 *  passed on `^text/`, so those render; **`image/svg+xml` did not**, so an SVG artifact came back
 *  with `text: null` and fell through to the raster `<img>` path instead of the sandboxed frame.
 *  Same for a mermaid file stored under a non-`text/` mime. Found by the viewer lane, which could
 *  not fix it — it owns the component, this file is the gate.
 *
 *  DELIBERATELY NOT `/^image\//` — that would start streaming PNG and JPEG bytes through the text
 *  preview path for no reason. SVG is here because it is TEXT that happens to carry an image mime,
 *  which is exactly why it slipped through the original `^text/` rule.
 *  `TEXT_PREVIEW_MAX_BYTES` still caps every one of these. */
const TEXT_PREVIEW_MIME =
  /^(text\/|application\/json|application\/csv|image\/svg\+xml|application\/vnd\.mermaid|application\/xhtml\+xml)/;
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
  // Both segments are sanitised again here rather than trusted from the row: rows written before the
  // traversal fix landed still hold whatever the model sent, and this is the call that puts them on a
  // real drive. `mirrorFileName` also disambiguates two artifacts whose names sanitise to the same
  // string — see its header; without it the path-keyed overwrite eats one of them.
  const r = await uploadArtifactToOneDrive({
    mailbox: row.user_email,
    lane: safeArtifactFolder(row.folder),
    name: mirrorFileName(row.id, row.name),
    bytes,
    mime: row.mime,
  });
  if (!r.ok) return { ok: false, error: r.error, needsConsent: r.needsConsent };
  await getPool().query(`UPDATE artifacts.items SET onedrive_url = $2, updated_at = now() WHERE id = $1`, [id, r.webUrl ?? null]);
  return { ok: true, onedrive_url: r.webUrl ?? null };
}

// B-OPS-2 -- ONE executor for the `list_artifacts` agent tool, called by BOTH surfaces.
//
// The text and voice paths each carry their OWN copy of the create_artifact dispatch, and
// realtime-tools.server.ts's own header records what that costs: NINE native tools that exist when
// typed and are silently absent when spoken, create_artifact among them until it was retro-fitted.
// A second tool with two copies of its dispatch would be the tenth. So the logic lives here once
// and each surface only routes the name to it -- the same shape as executeNexusTool.
//
// THE EMAIL COMES FROM THE SIGNED-IN CALLER AND IS NEVER A TOOL ARGUMENT. listArtifacts scopes
// every row by it, so an argument would be a read of another user's documents. `list_artifacts`
// exposes no email/user parameter and this function does not accept one.
export async function listArtifactsForTool(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller ?? {})) ?? caller?.entra_email;
  if (!email) return { ok: false, error: "sign_in_required" };

  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const n = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.trunc(Number(v));
    return undefined;
  };

  // An unrecognised status is DROPPED, not passed through: listArtifacts would append
  // `AND status = 'finished'`, match nothing, and the empty result would read as "no artifacts"
  // rather than as "that is not a status". Same rule as the library tool's `kind`.
  const statusRaw = s(args.status);
  const status = (ARTIFACT_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as ArtifactStatus)
    : undefined;
  const limit = Math.max(1, Math.min(n(args.limit) ?? 50, 200));
  const days = n(args.days);

  let rows: ArtifactRow[];
  try {
    rows = await listArtifacts(email, {
      folder: s(args.folder) || undefined,
      status,
      agentId: s(args.agent_id) || undefined,
      taskId: s(args.task_id) || undefined,
    });
  } catch {
    // Reported as a failed READ, never as an empty shelf. A broken query and a user with no
    // artifacts return the same thing otherwise, and "your agents haven't produced anything" is the
    // confidently-wrong answer this whole bridge exists to remove.
    return { ok: false, error: "artifact_store_unavailable" };
  }

  // `days` IS A CLIENT-SIDE WINDOW BECAUSE THE STORE HAS NO DATE FILTER. listArtifacts takes only
  // folder/status/agentId/taskId and then `ORDER BY updated_at DESC LIMIT 500`. Filtering here is
  // therefore over the newest 500, which is stated in the result rather than assumed away.
  let windowed = rows;
  let since: string | undefined;
  if (days !== undefined && days > 0) {
    const cutoff = Date.now() - days * 86_400_000;
    since = new Date(cutoff).toISOString();
    windowed = rows.filter((r) => {
      const t = Date.parse(String(r.updated_at ?? r.created_at ?? ""));
      return Number.isFinite(t) ? t >= cutoff : false;
    });
  }

  const artifacts = windowed.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    folder: r.folder,
    status: r.status,
    agent_id: r.agent_id,
    task_id: r.task_id,
    mime: r.mime,
    size_bytes: r.size_bytes,
    version: r.version,
    review_note: r.review_note,
    reviewed_at: r.reviewed_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    // Mirror state as a BOOLEAN, not a URL. A OneDrive/Drive link read aloud or pasted into a reply
    // is a live credentialed location; the model only needs to know whether it landed.
    mirrored: !!(r.onedrive_url || r.gdrive_url),
  }));
  // `blob_path` and `user_email` are deliberately not projected -- an internal storage key and the
  // caller's own address, neither of which the model needs and both of which it would repeat.

  return {
    ok: true,
    count: artifacts.length,
    total_matched: windowed.length,
    since,
    truncated: windowed.length > artifacts.length || undefined,
    store_scan_capped: rows.length >= 500 || undefined,
    artifacts,
    note:
      artifacts.length === 0
        ? days !== undefined
          ? `No artifacts were saved or updated in the last ${days} days. Say that, WITH the window used, and offer to look further back — do not tell the user his agents have produced nothing.`
          : "No artifacts matched those filters. Report it as 'nothing matched' and state the filters — do not report that the user has no documents unless an unfiltered read also returns nothing."
        : undefined,
  };
}
