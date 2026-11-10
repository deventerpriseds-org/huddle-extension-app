// WHAT:       Azure PG storage for Fireflies meeting minutes: (1) the owner's minutes settings (source,
//             recipients, update emails) and (2) a per-meeting processing ledger recording what happened
//             to each meeting -- minutes source, email result, OneDrive result -- which is also the
//             idempotency record that stops a webhook retry from emailing the same minutes twice.
// WHY:        Owner handoff 2026-11-10: "Make the handler idempotent. A webhook retry must not send
//             duplicate meeting-minutes email. Record the event/meeting processing status and email
//             delivery result." Settings follow the config-centric rule (code seeds, owner changes).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-minutes.test.ts; .claude/actions.md ACT:fireflies-minutes.
//
// Pool/bootstrap pattern copied from email-replies.server.ts. Never stores transcript text or secrets:
// only ids, titles, statuses, short error codes and a content hash.
import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.AZURE_PG_URL) throw new Error("AZURE_PG_URL not configured");
  _pool = getSharedPool();
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.meeting_minutes_settings (
  owner_email    TEXT PRIMARY KEY,
  minutes_source TEXT NOT NULL DEFAULT 'fireflies',   -- fireflies | luna
  recipients     TEXT[],                               -- NULL = the owner's own linked addresses
  update_emails  BOOLEAN NOT NULL DEFAULT false,       -- email again when Fireflies reprocesses a meeting
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat.fireflies_meetings (
  meeting_id      TEXT PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  title           TEXT,
  meeting_at      TIMESTAMPTZ,
  deliveries      INT NOT NULL DEFAULT 0,               -- webhook deliveries seen (retries + resends)
  minutes_source  TEXT,                                 -- the source used for the last email attempt
  summary_kind    TEXT,                                 -- custom | standard | luna
  content_hash    TEXT,                                 -- hash of the minutes last emailed
  email_status    TEXT,                                 -- NULL | sending | sent | failed
  email_recipients TEXT[],
  email_sent_at   TIMESTAMPTZ,
  email_error     TEXT,
  emails_sent     INT NOT NULL DEFAULT 0,
  onedrive_status TEXT,                                 -- saved | failed
  onedrive_path   TEXT,
  onedrive_error  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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

export interface MinutesSettingsRow {
  minutes_source: string | null;
  recipients: string[] | null;
  update_emails: boolean | null;
}

export async function getMinutesSettings(owner: string): Promise<MinutesSettingsRow | null> {
  await ensureBootstrapped();
  const r = await getPool().query<MinutesSettingsRow>(
    `SELECT minutes_source, recipients, update_emails FROM chat.meeting_minutes_settings WHERE owner_email = lower($1)`,
    [owner],
  );
  return r.rows[0] ?? null;
}

export async function setMinutesSettings(
  owner: string,
  s: { minutes_source: string; recipients: string[] | null; update_emails: boolean },
): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO chat.meeting_minutes_settings (owner_email, minutes_source, recipients, update_emails, updated_at)
     VALUES (lower($1), $2, $3, $4, now())
     ON CONFLICT (owner_email) DO UPDATE SET minutes_source = EXCLUDED.minutes_source,
       recipients = EXCLUDED.recipients, update_emails = EXCLUDED.update_emails, updated_at = now()`,
    [owner, s.minutes_source, s.recipients, s.update_emails],
  );
}

export interface MeetingRow {
  meeting_id: string;
  title: string | null;
  meeting_at: string | null;
  deliveries: number;
  minutes_source: string | null;
  summary_kind: string | null;
  content_hash: string | null;
  email_status: string | null;
  email_recipients: string[] | null;
  email_sent_at: string | null;
  email_error: string | null;
  emails_sent: number;
  onedrive_status: string | null;
  onedrive_path: string | null;
  onedrive_error: string | null;
  updated_at: string;
}

/** Record that a delivery arrived (creates the row on first sight). Returns the prior state. */
export async function noteDelivery(
  meetingId: string,
  owner: string,
  title: string | null,
  meetingAt: string | null,
): Promise<MeetingRow> {
  await ensureBootstrapped();
  const r = await getPool().query<MeetingRow>(
    `INSERT INTO chat.fireflies_meetings (meeting_id, owner_email, title, meeting_at, deliveries)
     VALUES ($1, lower($2), $3, $4, 1)
     ON CONFLICT (meeting_id) DO UPDATE SET deliveries = chat.fireflies_meetings.deliveries + 1,
       title = COALESCE(EXCLUDED.title, chat.fireflies_meetings.title),
       meeting_at = COALESCE(EXCLUDED.meeting_at, chat.fireflies_meetings.meeting_at), updated_at = now()
     RETURNING *`,
    [meetingId, owner, title, meetingAt],
  );
  return r.rows[0];
}

/** ATOMIC claim of the right to email this meeting. Exactly one concurrent delivery wins:
 *  - first send: email_status is NULL or 'failed'
 *  - update send: already 'sent', content changed, and the caller passed allowUpdate
 *  A 'sending' row older than 10 minutes is treated as a crashed attempt and may be reclaimed. */
export async function claimEmail(meetingId: string, hash: string, allowUpdate: boolean): Promise<boolean> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `UPDATE chat.fireflies_meetings SET email_status = 'sending', updated_at = now()
      WHERE meeting_id = $1 AND (
        email_status IS NULL OR email_status = 'failed'
        OR (email_status = 'sending' AND updated_at < now() - interval '10 minutes')
        OR ($3::boolean AND email_status = 'sent' AND content_hash IS DISTINCT FROM $2)
      )
      RETURNING meeting_id`,
    [meetingId, hash, allowUpdate],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function recordEmail(
  meetingId: string,
  r: { ok: boolean; source: string; kind: string; hash: string; recipients: string[]; error?: string },
): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET email_status = $2, minutes_source = $3, summary_kind = $4,
       content_hash = CASE WHEN $2 = 'sent' THEN $5 ELSE content_hash END,
       email_recipients = $6, email_error = $7,
       email_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE email_sent_at END,
       emails_sent = emails_sent + CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END, updated_at = now()
     WHERE meeting_id = $1`,
    [meetingId, r.ok ? "sent" : "failed", r.source, r.kind, r.hash, r.recipients, r.ok ? null : (r.error ?? "failed").slice(0, 300)],
  );
}

/** A delivery that decided NOT to email (setting/data problem before any claim) still leaves a visible,
 *  actionable error on the row -- without touching a previous successful send. */
export async function recordEmailSkipped(meetingId: string, source: string, error: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET minutes_source = $2, email_error = $3, updated_at = now(),
       email_status = CASE WHEN email_status = 'sent' THEN email_status ELSE 'failed' END
     WHERE meeting_id = $1`,
    [meetingId, source, error.slice(0, 300)],
  );
}

export async function recordOneDrive(meetingId: string, r: { ok: boolean; path?: string; error?: string }): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET onedrive_status = $2, onedrive_path = COALESCE($3, onedrive_path),
       onedrive_error = $4, updated_at = now() WHERE meeting_id = $1`,
    [meetingId, r.ok ? "saved" : "failed", r.path ?? null, r.ok ? null : (r.error ?? "failed").slice(0, 300)],
  );
}

export async function listRecentMeetings(owner: string, limit = 10): Promise<MeetingRow[]> {
  await ensureBootstrapped();
  const r = await getPool().query<MeetingRow>(
    `SELECT * FROM chat.fireflies_meetings WHERE owner_email = lower($1) ORDER BY updated_at DESC LIMIT $2`,
    [owner, limit],
  );
  return r.rows;
}
