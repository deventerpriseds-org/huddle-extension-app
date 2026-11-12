// WHAT:       Server half of the OneDrive file feed: reads the owner's EDS OneDrive snapshot files with the
//             EXISTING Graph app token, keeps a last-good copy per file, and hands validated, mapped
//             records to the existing inbox watch and calendar service.
// WHY:        see onedrive-feed.ts. This file only does I/O; every decision is in the pure module.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed.
// 2026-11-12: the drive I/O (metadata -> eTag short-circuit -> size check -> download -> size check) moved
//             into fetchDriveFile so the rolling Teams log (readTeamsLogFile) uses the SAME single download
//             path, token, deadline and size cap (AC-1.2). readFeed's behaviour is unchanged; its ok result
//             now also carries the eTag it served. AC: docs/ac/AC-correspondence-checklist.md section 1.
//
// Contract with the flows (owner's Power Automate): the files are REPLACE-IN-PLACE snapshots refreshed on
// source events. Huddle never cleans up, never writes, and never scans an unbounded log. A change is
// detected by the drive item's eTag; an unchanged eTag reuses the stored last-good snapshot. A snapshot
// that fails validation is recorded as the latest status but NEVER replaces the last good one.

import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import {
  coversWindow,
  eligibleFeedMessages,
  feedBelongsTo,
  mapFeedAppointments,
  mapFeedMessage,
  parseFeedsConfig,
  validateAppointmentSnapshot,
  validateEmailSnapshot,
  type FeedCalendarEvent,
  type OneDriveFeedsConfig,
  type ValidSnapshot,
} from "./onedrive-feed";
import type { InboundMessage } from "../email/inbound-email";
import type { TeamsFileRead } from "./teams-log";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** ONE deadline per file read (metadata + content together): a slow or hung drive must never hold up
 *  the EDS inbox or calendar for longer than this (verifier D9: per-request limits stacked to >16s). */
const FEED_READ_DEADLINE_MS = 10_000;
/** A calendar snapshot older than this gets a "may be out of date" note (the flow refreshes on calendar
 *  changes only, so a quiet week is legitimate -- this only flags a flow that may have stopped). */
const CALENDAR_AGE_WARN_MS = 7 * 24 * 3_600_000;

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = getSharedPool();
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.external_feed_state (
  feed_key      TEXT PRIMARY KEY,          -- kind + drive user + path (server config, never a payload)
  etag          TEXT,                      -- drive item eTag of the LAST GOOD snapshot
  published_utc TIMESTAMPTZ,               -- the last good snapshot's own published_utc
  last_good     JSONB,                     -- the last snapshot that passed validation
  last_status   TEXT NOT NULL DEFAULT 'never',  -- ok | unchanged | missing | rejected:<reason> | error
  last_error    TEXT,
  checked_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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

/** The feed config for THIS server, or null (feature off). Read at call time, never at module load. */
export function getFeedsConfig(): OneDriveFeedsConfig | null {
  return parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
}

type Kind = "email" | "appointments";

export type FeedRead =
  | { ok: true; snapshot: ValidSnapshot<Record<string, unknown>>; changed: boolean; etag?: string }
  | { ok: false; reason: string; lastGood?: ValidSnapshot<Record<string, unknown>> };

const drivePath = (cfg: OneDriveFeedsConfig, path: string) =>
  `${GRAPH}/users/${encodeURIComponent(cfg.driveUser)}/drive/root:${path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;

export type DriveFile =
  | { kind: "unchanged"; etag: string }
  | { kind: "text"; etag: string; itemId: string | null; text: string }
  | { kind: "fail"; reason: string; error?: string | null };

/**
 * THE one place Huddle downloads a feed file from the owner's drive (email, appointments, Teams log).
 * GET only: Huddle never writes, renames, moves or deletes a feed file (AC-1.13, AC-2.6). `knownEtag`
 * short-circuits an unchanged file before any download. Throws only on network/abort; callers map that.
 */
async function fetchDriveFile(cfg: OneDriveFeedsConfig, path: string, knownEtag: string | null): Promise<DriveFile> {
  const { getAppToken } = await import("../email/graph-email.server");
  const deadline = AbortSignal.timeout(FEED_READ_DEADLINE_MS);
  const timedFetch = (url: string, init: RequestInit) => fetch(url, { ...init, method: "GET", signal: deadline });
  const auth = { Authorization: `Bearer ${await getAppToken()}` };
  const meta = await timedFetch(`${drivePath(cfg, path)}?$select=id,eTag,size`, { headers: auth });
  if (meta.status === 404) return { kind: "fail", reason: "missing" };
  if (!meta.ok) return { kind: "fail", reason: "error", error: `drive item read failed (${meta.status})` };
  const item = (await meta.json()) as { id?: string; eTag?: string; size?: number };
  const etag = String(item.eTag ?? "");
  if (etag && knownEtag === etag) return { kind: "unchanged", etag };
  if (typeof item.size === "number" && item.size > cfg.maxBytes) return { kind: "fail", reason: "rejected:too_large" };
  const content = await timedFetch(`${drivePath(cfg, path)}:/content`, { headers: auth });
  if (!content.ok) return { kind: "fail", reason: "error", error: `drive content read failed (${content.status})` };
  const text = await content.text();
  if (text.length > cfg.maxBytes) return { kind: "fail", reason: "rejected:too_large" };
  return { kind: "text", etag, itemId: typeof item.id === "string" ? item.id : null, text };
}

/**
 * Read ONE feed file: eTag check -> download only when changed -> validate -> store as last good.
 * Never throws. On any failure the stored last-good snapshot (if any) rides back in `lastGood`, so a
 * caller can keep serving it while saying it is not current.
 */
export async function readFeed(cfg: OneDriveFeedsConfig, kind: Kind): Promise<FeedRead> {
  const file = cfg[kind];
  if (!file.enabled) return { ok: false, reason: "disabled" };
  const key = `${kind}:${cfg.driveUser}:${file.path}`;
  let state: { etag: string | null; last_good: ValidSnapshot<Record<string, unknown>> | null } = {
    etag: null,
    last_good: null,
  };
  const record = async (status: string, error: string | null, good?: { etag: string; snapshot: ValidSnapshot<Record<string, unknown>> }) => {
    try {
      if (good) {
        await getPool().query(
          `INSERT INTO chat.external_feed_state (feed_key, etag, published_utc, last_good, last_status, last_error, checked_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NULL, now(), now())
           ON CONFLICT (feed_key) DO UPDATE SET etag = EXCLUDED.etag, published_utc = EXCLUDED.published_utc,
             last_good = EXCLUDED.last_good, last_status = EXCLUDED.last_status, last_error = NULL,
             checked_at = now(), updated_at = now()`,
          [key, good.etag, good.snapshot.publishedUtc, JSON.stringify(good.snapshot), status],
        );
      } else {
        await getPool().query(
          `INSERT INTO chat.external_feed_state (feed_key, last_status, last_error, checked_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (feed_key) DO UPDATE SET last_status = EXCLUDED.last_status,
             last_error = EXCLUDED.last_error, checked_at = now(), updated_at = now()`,
          [key, status, error],
        );
      }
    } catch (err) {
      console.error("[onedrive-feed] state write failed", err instanceof Error ? err.message : err);
    }
  };
  try {
    await ensureBootstrapped();
    const { rows } = await getPool().query(
      `SELECT etag, last_good FROM chat.external_feed_state WHERE feed_key = $1`,
      [key],
    );
    if (rows[0]) state = { etag: rows[0].etag ?? null, last_good: rows[0].last_good ?? null };
  } catch (err) {
    console.error("[onedrive-feed] state read failed", err instanceof Error ? err.message : err);
  }
  const fail = async (reason: string, error: string | null = null): Promise<FeedRead> => {
    await record(reason, error);
    return { ok: false, reason, lastGood: state.last_good ?? undefined };
  };
  try {
    const got = await fetchDriveFile(cfg, file.path, state.last_good ? state.etag : null);
    if (got.kind === "fail") return fail(got.reason, got.error ?? null);
    if (got.kind === "unchanged") {
      await record("unchanged", null);
      return { ok: true, snapshot: state.last_good!, changed: false, etag: got.etag };
    }
    const { etag, text } = got;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail("rejected:not_json");
    }
    const v = kind === "email" ? validateEmailSnapshot(json, cfg) : validateAppointmentSnapshot(json, cfg);
    if (!v.ok) return fail(`rejected:${v.reason}`);
    // Malformed records (no id) are dropped, not fatal -- but say so, or the flow's bug is invisible.
    const skippedNote = v.snapshot.skipped ? `skipped ${v.snapshot.skipped} record(s) with no id` : null;
    if (skippedNote) console.warn(`[onedrive-feed] ${kind}: ${skippedNote}`);
    await record("ok", skippedNote, { etag, snapshot: v.snapshot });
    return { ok: true, snapshot: v.snapshot, changed: true, etag };
  } catch (err) {
    return fail("error", err instanceof Error ? err.message.slice(0, 200) : "unknown");
  }
}

/** The feed_key of the Teams log's state row (AC-1.2: same table, `teams:` prefix). */
export const teamsFeedKey = (cfg: OneDriveFeedsConfig) => `teams:${cfg.driveUser}:${cfg.teams.path}`;

/** Record the Teams log's latest read status (and, on a good read, its eTag) in chat.external_feed_state.
 *  last_good stays NULL for the Teams row: the processing ledger, not a stored copy, is its memory. The note
 *  carries counts and reason names only (teamsParseNote), never a line. Never throws. */
export async function recordTeamsFeedStatus(cfg: OneDriveFeedsConfig, status: string, note: string | null, etag?: string): Promise<void> {
  try {
    await ensureBootstrapped();
    await getPool().query(
      `INSERT INTO chat.external_feed_state (feed_key, etag, last_status, last_error, checked_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (feed_key) DO UPDATE SET etag = COALESCE(EXCLUDED.etag, chat.external_feed_state.etag),
         last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error, checked_at = now(), updated_at = now()`,
      [teamsFeedKey(cfg), etag ?? null, status, note],
    );
  } catch (err) {
    console.error("[onedrive-feed] teams state write failed", err instanceof Error ? err.message : err);
  }
}

/**
 * Read the rolling Teams JSON Lines log through fetchDriveFile (same token, deadline, size cap, eTag rule
 * as every other feed file; GET only). `knownEtag` is what the processing ledger last ingested: an equal
 * eTag returns `changed:false` with no download. A failure is recorded here; a successful download is
 * recorded by the caller AFTER it parses (only the parser knows `rejected:not_jsonl` and the skip counts).
 * A file over maxBytes is `rejected:too_large` and nothing is re-emitted (AC-1.8; trim policy is OQ-3).
 * Never throws.
 */
export async function readTeamsLogFile(cfg: OneDriveFeedsConfig, knownEtag: string | null): Promise<TeamsFileRead> {
  if (!cfg.teams.enabled) return { ok: false, reason: "disabled" };
  try {
    const got = await fetchDriveFile(cfg, cfg.teams.path, knownEtag);
    if (got.kind === "fail") {
      await recordTeamsFeedStatus(cfg, got.reason, got.error ?? null);
      return { ok: false, reason: got.reason };
    }
    if (got.kind === "unchanged") {
      await recordTeamsFeedStatus(cfg, "unchanged", null);
      return { ok: true, changed: false, etag: got.etag };
    }
    return { ok: true, changed: true, etag: got.etag, itemId: got.itemId, path: cfg.teams.path, text: got.text };
  } catch (err) {
    // An abort / network error: the category only (a Graph error body could carry anything).
    const reason = err instanceof Error && err.name === "TimeoutError" ? "error:timeout" : "error";
    await recordTeamsFeedStatus(cfg, reason, null);
    return { ok: false, reason };
  }
}

/**
 * The work-mailbox email this run should screen, mapped to InboundMessage and filtered by the lookback,
 * notBefore and (while synthetic) the test subject prefix. null when the feed is off or not this
 * owner's. Ingestion is idempotent downstream (one turn id per original message), so re-reading the
 * same snapshot every run loses nothing and announces nothing twice.
 */
export async function feedEmailMessages(
  identities: (string | undefined | null)[],
  sinceIso: string,
): Promise<{ mailbox: string; messages: InboundMessage[]; warning?: string } | null> {
  const cfg = getFeedsConfig();
  if (!cfg || !cfg.email.enabled || !feedBelongsTo(cfg, ...identities)) return null;
  const r = await readFeed(cfg, "email");
  const snap = r.ok ? r.snapshot : r.lastGood;
  const warning = r.ok ? undefined : `work-mailbox feed not current (${r.reason})`;
  if (!snap) return { mailbox: cfg.mailbox, messages: [], warning };
  const mapped = snap.records.map((rec) => mapFeedMessage(rec, cfg.mailbox));
  return { mailbox: cfg.mailbox, messages: eligibleFeedMessages(mapped, cfg, sinceIso), warning };
}

/**
 * The work calendar's events inside [startISO, endISO], rendered in `timeZone`. Never throws, and never
 * returns a silent empty list for a broken feed: anything not current or not covering the window comes
 * back as a warning the reader must pass on.
 */
export async function feedCalendarEvents(
  identities: (string | undefined | null)[],
  startISO: string,
  endISO: string,
  timeZone: string,
): Promise<{ events: FeedCalendarEvent[]; warnings: string[] }> {
  const cfg = getFeedsConfig();
  if (!cfg || !cfg.appointments.enabled || !feedBelongsTo(cfg, ...identities)) return { events: [], warnings: [] };
  const r = await readFeed(cfg, "appointments");
  const snap = r.ok ? r.snapshot : r.lastGood;
  const warnings: string[] = [];
  if (!r.ok) {
    warnings.push(
      snap
        ? `Work calendar feed is not current (${r.reason}); showing the last good copy from ${snap.publishedUtc}.`
        : `Work calendar feed unavailable (${r.reason}); work meetings are NOT included.`,
    );
  }
  if (!snap) return { events: [], warnings };
  if (Date.now() - Date.parse(snap.publishedUtc) > CALENDAR_AGE_WARN_MS) {
    warnings.push(`Work calendar feed was last updated ${snap.publishedUtc}; it may be out of date.`);
  }
  if (!coversWindow(snap, startISO, endISO)) {
    warnings.push("Work calendar feed only covers part of the requested dates; work meetings may be missing.");
  }
  return { events: mapFeedAppointments(snap.records, cfg.mailbox, startISO, endISO, timeZone), warnings };
}
