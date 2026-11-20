// WHAT:       the Trinnex Library server: metadata rows (schema `trinnex` in the existing RAG_AI_Agents database,
//             on the ONE shared pool), uploaded bytes in a NEW private blob container `trinnex-library` on the SAME
//             storage account, and the processing pipeline Uploaded -> Read -> Split -> Facts -> Searchable that
//             hands segments to the memory lane (ingestTrinnexSource) and removes through deleteTrinnexSource.
// WHY:        AC-trinnex-workspace.md section 2 (AC-L6, L7, L8, L10, L11, L14), section 4 (AC-C1, C2, C4, C5, C7)
//             and decision Q1 (remove deletes passages, facts AND the stored file).
// COST:       $0 idle. No new server, database, secret or timer: a new SCHEMA in RAG_AI_Agents on eds-postgresql,
//             a new private container on the existing account behind AZURE_STORAGE_CONNECTION_STRING (pennies per
//             GB stored, nothing when idle), and the work rides the existing once-a-minute heartbeat
//             (lib/tasks/scheduler.server.ts runDueScheduledJobs), like Fireflies.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-library.test.ts ("pipeline ..." / "remove ..."); BUILD-trinnex-library.md.
//
// Logging rule (AC-C4): ids, step names, counts and reason CODES only. Never a file name, text or person name.
import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import {
  type FailReason,
  factsFailReason,
  type LibraryKind,
  type LibraryStatus,
  type Segment,
  STEPS,
  capSegments,
  cleanCategory,
  mergeCategories,
  turnsFromCues,
} from "./library-core";
import { speakerKey } from "./names";

export const LIBRARY_CONTAINER = "trinnex-library";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.AZURE_PG_URL) throw new Error("AZURE_PG_URL not configured");
  _pool = getSharedPool();
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS trinnex;
CREATE TABLE IF NOT EXISTS trinnex.library_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email   TEXT NOT NULL,
  name          TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  file_type     TEXT NOT NULL,                         -- the lower-case extension: pdf | docx | ... | srt
  kind          TEXT NOT NULL CHECK (kind IN ('document','transcript')),
  category      TEXT NOT NULL DEFAULT 'General',
  participants  TEXT[] NOT NULL DEFAULT '{}',
  speaker_map   JSONB NOT NULL DEFAULT '{}'::jsonb,    -- raw label -> person
  doc_date      DATE,
  status        TEXT NOT NULL DEFAULT 'uploaded',
  failed_step   TEXT,
  fail_reason   TEXT,                                  -- a reason CODE, never text from the file
  chunks        INT NOT NULL DEFAULT 0,
  facts         INT NOT NULL DEFAULT 0,
  blob_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                         -- sha256 of the bytes (AC-L10 duplicate check)
  attempts      INT NOT NULL DEFAULT 0,
  lease_until   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_items_owner_idx ON trinnex.library_items (lower(owner_email), created_at DESC);
CREATE INDEX IF NOT EXISTS library_items_due_idx ON trinnex.library_items (status, created_at);
CREATE TABLE IF NOT EXISTS trinnex.library_categories (
  owner_email TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS library_categories_key ON trinnex.library_categories (lower(owner_email), lower(name));
`;

let bootstrapped: Promise<void> | null = null;
async function ensureBootstrapped(): Promise<void> {
  if (!bootstrapped) bootstrapped = getPool().query(BOOTSTRAP_SQL).then(() => undefined);
  try {
    await bootstrapped;
  } catch (e) {
    bootstrapped = null;
    throw e;
  }
}

export interface LibraryItem {
  id: string;
  ownerEmail: string;
  name: string;
  sizeBytes: number;
  fileType: string;
  kind: LibraryKind;
  category: string;
  participants: string[];
  speakerMap: Record<string, string>;
  docDate: string | null;
  status: LibraryStatus;
  failedStep: string | null;
  failReason: FailReason | string | null;
  chunks: number;
  facts: number;
  blobPath: string;
  createdAt: string;
}

type Row = Record<string, unknown>;
function toItem(r: Row): LibraryItem {
  const d = r.doc_date as Date | string | null;
  return {
    id: String(r.id),
    ownerEmail: String(r.owner_email),
    name: String(r.name),
    sizeBytes: Number(r.size_bytes),
    fileType: String(r.file_type),
    kind: r.kind as LibraryKind,
    category: String(r.category),
    participants: (r.participants as string[]) ?? [],
    speakerMap: (r.speaker_map as Record<string, string>) ?? {},
    docDate: d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null,
    status: r.status as LibraryStatus,
    failedStep: (r.failed_step as string) ?? null,
    failReason: (r.fail_reason as string) ?? null,
    chunks: Number(r.chunks ?? 0),
    facts: Number(r.facts ?? 0),
    blobPath: String(r.blob_path),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

const log = (event: string, fields: Record<string, string | number | null>) =>
  console.log(`[trinnex-library] ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);

// ── Pipeline and removal (dependency-injected, so they are tested offline) ─────────────────────────

export interface MemoryPort {
  configured(): boolean;
  ingest(input: {
    sourceId: string;
    sourceKind: "upload";
    title: string;
    date: string | null;
    category: string;
    participants: string[];
    segments: Segment[];
    ownerEmail: string;
    /** VA9: checked by the memory lane before every write; true = the item was Removed, stop and clean up. */
    shouldStop?: () => boolean | Promise<boolean>;
  }): Promise<{ chunks: number; facts: number; factsFailure?: string | null; cancelled?: boolean }>;
  /** RT-I3: removes only THIS owner's rows for the source. */
  remove(sourceId: string, ownerEmail: string): Promise<{ chunks: number; facts: number }>;
}

export interface PipelineDeps {
  getBytes(path: string): Promise<Uint8Array | null>;
  deleteBytes(path: string): Promise<boolean>;
  extract(name: string, bytes: Uint8Array, kind: LibraryKind): Promise<{ segments: Segment[]; cues: import("./library-core").Cue[] }>;
  memory: MemoryPort;
  update(id: string, patch: Partial<Pick<LibraryItem, "status" | "failedStep" | "failReason" | "chunks" | "facts">>): Promise<void>;
  deleteRow(id: string): Promise<void>;
  /** VA9: has this item been Removed (row gone, or status removing / remove_incomplete)? Read before every pipeline
   *  write. Live: one SELECT on the row, so a Remove in ANOTHER server process is seen too. */
  isRemoved?(id: string): Promise<boolean>;
  /** VA9: mark the row `removing` atomically and report whether a worker holds its processing lease right now. When
   *  one does, that worker finishes the removal (it sees the tombstone before its next write), so the Library row
   *  keeps pointing at every passage until the last one is deleted. Absent = no lease to consult. */
  beginRemoval?(id: string): Promise<{ inFlight: boolean }>;
}

/** VA9: in-process tombstones. runRemoval adds the id BEFORE deleting anything; runPipeline (and through
 *  `shouldStop`, the memory lane) checks it before every write. ids are UUIDs and never reused. The live
 *  `isRemoved` covers a Remove that ran in a different server process. */
const removalTombstones = new Set<string>();

/** Classify an AI/ingest failure KIND (AC-C5). Never returns or logs the message text. */
export function ingestFailReason(e: unknown): FailReason {
  const s = `${(e as { status?: unknown })?.status ?? ""} ${(e as { code?: unknown })?.code ?? ""} ${String((e as Error)?.message ?? "")}`;
  return /insufficient_quota|\b429\b|quota/i.test(s) ? "ai_quota" : "ingest_error";
}

/**
 * Run one item through Read -> Split -> Facts -> Searchable. Each step is written BEFORE the next starts, so the
 * stepper follows the server (AC-L6). A failure names its step and a reason code; a failure during ingestion
 * also deletes whatever the memory lane may have written for this source, so nothing is half-searchable.
 */
export async function runPipeline(item: LibraryItem, deps: PipelineDeps): Promise<LibraryStatus> {
  // VA9: Remove may run at ANY point while this runs (another request, another process). Before every write the
  // pipeline asks whether it was removed; if so it writes nothing more and finishes the removal itself, so no
  // passage or fact can outlive the row.
  const removed = async (): Promise<boolean> =>
    removalTombstones.has(item.id) || (deps.isRemoved ? await deps.isRemoved(item.id) : false);
  const stopForRemoval = async (): Promise<LibraryStatus> => {
    const r = await completeRemoval(item, deps);
    log("pipeline_stopped_for_removal", { id: item.id, removed: r.removed ? 1 : 0 });
    return r.removed ? "removing" : "remove_incomplete";
  };
  const fail = async (step: string, reason: FailReason) => {
    if (await removed()) return stopForRemoval();
    await deps.update(item.id, { status: "failed", failedStep: step, failReason: reason, chunks: 0, facts: 0 });
    log("failed", { id: item.id, step, reason });
    return "failed" as const;
  };
  if (await removed()) return stopForRemoval();
  const bytes = await deps.getBytes(item.blobPath);
  if (!bytes) return fail(STEPS[1], "storage_error");
  let extracted;
  try {
    extracted = await deps.extract(item.name, bytes, item.kind);
  } catch (e) {
    const reason = ((e as { reason?: FailReason })?.reason ?? "corrupt_file") as FailReason;
    return fail(STEPS[1], reason);
  }
  if (await removed()) return stopForRemoval();
  await deps.update(item.id, { status: "read", failedStep: null, failReason: null });
  const segments =
    extracted.cues.length > 0
      ? capSegments(turnsFromCues(extracted.cues, speakerKey, item.speakerMap))
      : capSegments(extracted.segments);
  if (!segments.length) return fail(STEPS[2], "no_readable_text");
  if (await removed()) return stopForRemoval();
  await deps.update(item.id, { status: "split" });
  if (!deps.memory.configured()) {
    if (await removed()) return stopForRemoval();
    await deps.update(item.id, { status: "waiting_memory", chunks: 0, facts: 0 });
    log("waiting_memory", { id: item.id, segments: segments.length });
    return "waiting_memory";
  }
  let counts: { chunks: number; facts: number; factsFailure?: string | null; cancelled?: boolean };
  if (await removed()) return stopForRemoval();
  try {
    counts = await deps.memory.ingest({
      sourceId: item.id,
      sourceKind: "upload",
      title: item.name,
      date: item.docDate,
      category: item.category,
      participants: item.participants,
      segments,
      ownerEmail: item.ownerEmail,
      shouldStop: removed,
    });
  } catch (e) {
    const reason = ingestFailReason(e);
    try {
      await deps.memory.remove(item.id, item.ownerEmail);
    } catch {
      /* the failed status below still tells the owner; Retry re-ingests, which replaces by source */
    }
    return fail(STEPS[3], reason);
  }
  if (counts.cancelled || (await removed())) return stopForRemoval();
  if (!counts.chunks) return fail(STEPS[3], "no_readable_text");
  await deps.update(item.id, { status: "facts", chunks: counts.chunks, facts: counts.facts });
  if (await removed()) return stopForRemoval();
  // AC-C5: passages are searchable, but a fact-extraction failure is RECORDED (kind only) so the item says
  // "Facts not extracted: AI quota exhausted" instead of silently showing 0 facts.
  await deps.update(item.id, { status: "searchable", failReason: counts.factsFailure ? factsFailReason(counts.factsFailure) : null });
  // VA9: a Remove deferred to this worker while the last update ran is finished here, before the lease is released.
  if (await removed()) return stopForRemoval();
  log("searchable", { id: item.id, chunks: counts.chunks, facts: counts.facts });
  return "searchable";
}

export interface RemovalResult {
  removed: boolean;
  /** What still exists when removal is incomplete: "memory" (passages/facts) and/or "file" (the blob). */
  remaining: Array<"memory" | "file">;
  /** VA9: a worker was mid-run on this item. The row is `removing` (the button says "Removing..."), the worker saw
   *  the tombstone and finishes the removal itself before writing anything more; the list refresh shows it gone. */
  pending?: boolean;
}

/**
 * Decision Q1 / AC-L7 / AC-L8: delete the passages AND facts (deleteTrinnexSource), the stored blob, and only then
 * the metadata row. If any delete fails, the row stays as `remove_incomplete` naming what remains, and calling
 * this again retries only what is needed (every step is idempotent). Never reports removed while anything survives.
 */
export async function runRemoval(item: LibraryItem, deps: PipelineDeps): Promise<RemovalResult> {
  // VA9: the tombstone goes up BEFORE anything is deleted, so a worker that is mid-run stops before its next write.
  removalTombstones.add(item.id);
  if (deps.beginRemoval) {
    const { inFlight } = await deps.beginRemoval(item.id);
    if (inFlight) {
      // A worker holds the lease: it owns the deletes. The row stays (status removing) until the worker has removed
      // the last passage, so nothing is ever left with no row pointing at it.
      log("remove_deferred_to_worker", { id: item.id });
      return { removed: false, remaining: [], pending: true };
    }
  } else {
    await deps.update(item.id, { status: "removing" });
  }
  return completeRemoval(item, deps);
}

/** The deletes themselves (memory, blob, then the row). Idempotent; shared by runRemoval and a worker that was
 *  stopped mid-run by a Remove. */
async function completeRemoval(item: LibraryItem, deps: PipelineDeps): Promise<RemovalResult> {
  removalTombstones.add(item.id);
  const remaining: RemovalResult["remaining"] = [];
  const mayHaveMemory = item.chunks > 0 || item.facts > 0 || ["split", "facts", "searchable", "removing", "remove_incomplete"].includes(item.status);
  if (deps.memory.configured()) {
    try {
      await deps.memory.remove(item.id, item.ownerEmail);
    } catch {
      remaining.push("memory");
    }
  } else if (mayHaveMemory && (item.chunks > 0 || item.facts > 0)) {
    remaining.push("memory");
  }
  if (!(await deps.deleteBytes(item.blobPath))) remaining.push("file");
  if (remaining.length) {
    await deps.update(item.id, { status: "remove_incomplete", failReason: remaining.join(",") });
    log("remove_incomplete", { id: item.id, remaining: remaining.join(",") });
    return { removed: false, remaining };
  }
  await deps.deleteRow(item.id);
  log("removed", { id: item.id });
  return { removed: true, remaining: [] };
}

// ── pg + blob bindings ───────────────────────────────────────────────────────────────────────────────

async function update(id: string, patch: Parameters<PipelineDeps["update"]>[1]): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [id];
  const map: Record<string, string> = { status: "status", failedStep: "failed_step", failReason: "fail_reason", chunks: "chunks", facts: "facts" };
  for (const [k, v] of Object.entries(patch)) {
    vals.push(v);
    cols.push(`${map[k]} = $${vals.length}`);
  }
  if (!cols.length) return;
  // VA9: a pipeline write never overwrites a removal in progress. Only the removal itself moves a row out of
  // `removing` (to `remove_incomplete`).
  const removalWrite = patch.status === "removing" || patch.status === "remove_incomplete";
  const guard = removalWrite ? "" : ` AND status NOT IN ('removing','remove_incomplete')`;
  await getPool().query(`UPDATE trinnex.library_items SET ${cols.join(", ")}, updated_at = now() WHERE id = $1${guard}`, vals);
}

/** VA9: removed = the row is gone or is being removed. */
async function isRemoved(id: string): Promise<boolean> {
  const r = await getPool().query(`SELECT status FROM trinnex.library_items WHERE id = $1`, [id]);
  const st = r.rows[0]?.status as string | undefined;
  return !st || st === "removing" || st === "remove_incomplete";
}

/** VA9: one statement, so it serialises with claim() on the row lock. in_flight = a worker held an unexpired lease
 *  on a processing status at the moment the row became `removing`. */
async function beginRemoval(id: string): Promise<{ inFlight: boolean }> {
  const r = await getPool().query(
    `WITH old AS (SELECT id, status, lease_until FROM trinnex.library_items WHERE id = $1 FOR UPDATE)
     UPDATE trinnex.library_items t SET status = 'removing', updated_at = now()
       FROM old WHERE t.id = old.id
     RETURNING (old.lease_until IS NOT NULL AND old.lease_until > now()
                AND old.status IN ('uploaded','read','split','facts','waiting_memory')) AS in_flight`,
    [id],
  );
  return { inFlight: r.rows[0]?.in_flight === true };
}

async function liveDeps(): Promise<PipelineDeps> {
  const blob = await import("../artifacts/blob.server");
  const mem = await import("./memory.server");
  const { extractFile } = await import("./extract.server");
  return {
    getBytes: (p) => blob.getArtifactBlobBytes(p, LIBRARY_CONTAINER),
    deleteBytes: (p) => blob.deleteArtifactBlob(p, LIBRARY_CONTAINER),
    extract: extractFile,
    memory: {
      configured: () => mem.trinnexConfigured(),
      ingest: (input) => mem.ingestTrinnexSource({ ...input, series: null }),
      remove: (id, ownerEmail) => mem.deleteTrinnexSource(id, ownerEmail),
    },
    update,
    deleteRow: async (id) => {
      await getPool().query(`DELETE FROM trinnex.library_items WHERE id = $1`, [id]);
    },
    isRemoved,
    beginRemoval,
  };
}

/** Owner-scoped list (AC-C7: every read is scoped to the caller's email). */
export async function listLibrary(email: string): Promise<{ items: LibraryItem[]; categories: string[] }> {
  await ensureBootstrapped();
  const [items, cats] = await Promise.all([
    getPool().query(`SELECT * FROM trinnex.library_items WHERE lower(owner_email) = lower($1) ORDER BY created_at DESC LIMIT 500`, [email]),
    getPool().query(`SELECT name FROM trinnex.library_categories WHERE lower(owner_email) = lower($1) ORDER BY created_at`, [email]),
  ]);
  const list = items.rows.map(toItem);
  return { items: list, categories: mergeCategories(cats.rows.map((r) => String(r.name)), list.map((i) => i.category)) };
}

export async function getLibraryItem(email: string, id: string): Promise<LibraryItem | null> {
  await ensureBootstrapped();
  const r = await getPool().query(`SELECT * FROM trinnex.library_items WHERE id = $1 AND lower(owner_email) = lower($2)`, [id, email]);
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

export async function findDuplicate(email: string, hash: string): Promise<LibraryItem | null> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `SELECT * FROM trinnex.library_items WHERE lower(owner_email) = lower($1) AND content_hash = $2 ORDER BY created_at DESC LIMIT 1`,
    [email, hash],
  );
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

export interface NewUpload {
  name: string;
  fileType: string;
  kind: LibraryKind;
  category: string;
  participants: string[];
  speakerMap: Record<string, string>;
  docDate: string | null;
  bytes: Uint8Array;
  mime: string;
  hash: string;
}

/** Store the blob FIRST, then the row (status `uploaded`), so a row never points at a missing file. */
export async function createUpload(email: string, u: NewUpload): Promise<LibraryItem> {
  await ensureBootstrapped();
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const blobPath = `${email.toLowerCase()}/${id}.${u.fileType}`;
  const { putArtifactBlob } = await import("../artifacts/blob.server");
  await putArtifactBlob(blobPath, u.bytes, u.mime, LIBRARY_CONTAINER);
  const category = cleanCategory(u.category);
  const r = await getPool().query(
    `INSERT INTO trinnex.library_items (id, owner_email, name, size_bytes, file_type, kind, category, participants, speaker_map,
       doc_date, status, blob_path, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'uploaded',$11,$12) RETURNING *`,
    [id, email, u.name.slice(0, 255), u.bytes.byteLength, u.fileType, u.kind, category, u.participants.slice(0, 40),
      JSON.stringify(u.speakerMap), u.docDate, blobPath, u.hash],
  );
  await getPool().query(
    `INSERT INTO trinnex.library_categories (owner_email, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [email, category],
  );
  log("uploaded", { id, bytes: u.bytes.byteLength });
  return toItem(r.rows[0]);
}

/** Speakers set later from the drawer (AC-L5): store the map and re-queue; re-ingest replaces by source. */
export async function setSpeakerMap(email: string, id: string, map: Record<string, string>, participants: string[]): Promise<boolean> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `UPDATE trinnex.library_items SET speaker_map = $3::jsonb, participants = $4, status = 'uploaded', attempts = 0,
       failed_step = NULL, fail_reason = NULL, lease_until = NULL, updated_at = now()
     WHERE id = $1 AND lower(owner_email) = lower($2) AND status NOT IN ('removing','remove_incomplete')`,
    [id, email, JSON.stringify(map), participants.slice(0, 40)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Retry a failed item from the start (AC-L6 Retry button). */
export async function requeue(email: string, id: string): Promise<boolean> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `UPDATE trinnex.library_items SET status = 'uploaded', attempts = 0, failed_step = NULL, fail_reason = NULL,
       lease_until = NULL, updated_at = now()
     WHERE id = $1 AND lower(owner_email) = lower($2) AND status IN ('failed','waiting_memory')`,
    [id, email],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Claim one due item under a 3-minute lease (two workers never process one item at once). `id` narrows the claim
 *  to one item (the client's immediate kick after upload); otherwise the oldest due item is taken. */
async function claim(configured: boolean, only?: { id: string; email: string }): Promise<LibraryItem | null> {
  const r = await getPool().query(
    `UPDATE trinnex.library_items SET lease_until = now() + interval '3 minutes', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM trinnex.library_items
       WHERE ((status IN ('uploaded','read','split','facts') OR (status = 'waiting_memory' AND $1::boolean))
              AND attempts < 5
           -- VA9: a removal deferred to a worker that then died is finished by the next heartbeat.
           OR (status = 'removing' AND updated_at < now() - interval '2 minutes'))
         AND (lease_until IS NULL OR lease_until < now())
         AND ($2::uuid IS NULL OR (id = $2::uuid AND lower(owner_email) = lower($3)))
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [configured, only?.id ?? null, only?.email ?? ""],
  );
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

async function release(id: string): Promise<void> {
  await getPool().query(`UPDATE trinnex.library_items SET lease_until = NULL WHERE id = $1`, [id]);
}

/** Process one item now (the client's kick right after upload). Returns its final status, or null if not claimable. */
export async function processLibraryItem(email: string, id: string): Promise<LibraryStatus | null> {
  await ensureBootstrapped();
  const deps = await liveDeps();
  const item = await claim(deps.memory.configured(), { id, email });
  if (!item) return null;
  try {
    if (item.status === "removing") return (await completeRemoval(item, deps)).removed ? "removing" : "remove_incomplete";
    return await runPipeline(item, deps);
  } finally {
    await release(item.id);
  }
}

/** Heartbeat entry: process up to `limit` due items. Never throws (a heartbeat must not fail on one file). */
export async function processDueLibraryItems(limit = 1): Promise<number> {
  if (!process.env.AZURE_PG_URL) return 0;
  let done = 0;
  try {
    await ensureBootstrapped();
    const deps = await liveDeps();
    for (let i = 0; i < limit; i++) {
      const item = await claim(deps.memory.configured());
      if (!item) break;
      try {
        if (item.status === "removing") await completeRemoval(item, deps);
        else await runPipeline(item, deps);
        done++;
      } catch (e) {
        log("worker_error", { id: item.id, kind: (e as Error)?.name ?? "Error" });
      } finally {
        await release(item.id);
      }
    }
  } catch (e) {
    log("heartbeat_error", { kind: (e as Error)?.name ?? "Error" });
  }
  return done;
}

export async function removeLibraryItem(email: string, id: string): Promise<RemovalResult | null> {
  const item = await getLibraryItem(email, id);
  if (!item) return null; // wrong owner or gone: nothing to remove, and nothing leaks (AC-C7)
  return runRemoval(item, await liveDeps());
}

/**
 * The Fireflies row (read only): meetings waiting for triage. Uses the meetings lane's `triaged_at` column when it
 * exists on chat.fireflies_meetings; until then no meeting has been triaged in Trinnex, so every recorded meeting
 * for the owner counts. Returns null when the table is absent (Fireflies never set up).
 */
export async function firefliesWaiting(email: string): Promise<number | null> {
  const pool = getPool();
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'chat' AND table_name = 'fireflies_meetings'`,
  );
  if (!cols.rowCount) return null;
  const has = new Set(cols.rows.map((r) => String(r.column_name)));
  const where = has.has("triaged_at") ? "AND triaged_at IS NULL" : "";
  const r = await pool.query(`SELECT count(*)::int AS n FROM chat.fireflies_meetings WHERE lower(owner_email) = lower($1) ${where}`, [email]);
  return Number(r.rows[0]?.n ?? 0);
}

// SUPERSEDED (integration pass 2026-11-20): `peopleFrom(items)`, the Library's interim people list built from names
// already tagged in the Library. The pickers now read and write the ONE owner-scoped list, chat.trinnex_people
// (meetings.server getPeople / rememberPeople), via library.functions.ts.
