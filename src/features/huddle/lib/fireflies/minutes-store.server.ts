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
-- Work queue (2026-11-10, verify loop 1): the webhook only RECORDS a delivery and answers fast (Fireflies
-- gives an endpoint 30s and does not retry a timed-out request); the existing once-a-minute run-turn
-- heartbeat (scheduler.server runDueScheduledJobs) does the work under a per-meeting LEASE, so two
-- workers can never process one meeting at once and a crashed worker's lease simply expires.
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS pending_email BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS pending_onedrive BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS last_event TEXT;
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS last_reprocessed_at BIGINT;
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE chat.fireflies_meetings ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS fireflies_meetings_due_idx ON chat.fireflies_meetings(next_attempt_at)
  WHERE pending_email OR pending_onedrive;
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
  owner_email: string;
  title: string | null;
  meeting_at: string | null;
  deliveries: number;
  minutes_source: string | null;
  summary_kind: string | null;
  content_hash: string | null;
  email_status: string | null; // NULL | sent | failed
  email_recipients: string[] | null;
  email_sent_at: string | null;
  email_error: string | null;
  emails_sent: number;
  onedrive_status: string | null;
  onedrive_path: string | null;
  onedrive_error: string | null;
  pending_email: boolean;
  pending_onedrive: boolean;
  last_event: string | null;
  last_reprocessed_at: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

/** Record one webhook delivery and queue the work it implies. Fast (one statement).
 *  - a first delivery queues OneDrive + email
 *  - a RESEND (reprocessed_at newer than stored) queues OneDrive again, and email again (the worker then
 *    sends only if the owner's update-emails switch is on AND the content really changed)
 *  - a retry / out-of-order copy (reprocessed_at not newer) only bumps the delivery count
 *  - meeting.summarized re-queues the email when no minutes have been sent yet (Fireflies-summary mode
 *    waits for it). */
export async function recordWebhook(
  meetingId: string,
  owner: string,
  event: string,
  reprocessedAt: number | null,
): Promise<{ queued: boolean }> {
  await ensureBootstrapped();
  const r = await getPool().query<{ queued: boolean }>(
    `INSERT INTO chat.fireflies_meetings (meeting_id, owner_email, deliveries, last_event, last_reprocessed_at,
        pending_email, pending_onedrive, next_attempt_at)
     VALUES ($1, lower($2), 1, $3, $4, true, true, now())
     ON CONFLICT (meeting_id) DO UPDATE SET
       deliveries = chat.fireflies_meetings.deliveries + 1,
       last_event = EXCLUDED.last_event,
       last_reprocessed_at = GREATEST(chat.fireflies_meetings.last_reprocessed_at, EXCLUDED.last_reprocessed_at),
       pending_onedrive = chat.fireflies_meetings.pending_onedrive
         OR (EXCLUDED.last_reprocessed_at IS NOT NULL
             AND EXCLUDED.last_reprocessed_at > COALESCE(chat.fireflies_meetings.last_reprocessed_at, 0))
         OR chat.fireflies_meetings.onedrive_status IS DISTINCT FROM 'saved'
         OR EXCLUDED.last_event = 'meeting.summarized',   -- the file gains the summary once it exists
       pending_email = chat.fireflies_meetings.pending_email
         OR (EXCLUDED.last_reprocessed_at IS NOT NULL
             AND EXCLUDED.last_reprocessed_at > COALESCE(chat.fireflies_meetings.last_reprocessed_at, 0))
         OR chat.fireflies_meetings.email_status IS DISTINCT FROM 'sent',
       attempts = 0,
       next_attempt_at = now(),
       updated_at = now()
     RETURNING (pending_email OR pending_onedrive) AS queued`,
    [meetingId, owner, event, reprocessedAt],
  );
  return { queued: !!r.rows[0]?.queued };
}

/** Lease up to `limit` meetings whose work is due. SKIP LOCKED + the lease mean a meeting is worked by
 *  at most one heartbeat at a time; a crashed worker's lease lapses after 3 minutes. */
export async function claimDueMeetings(limit: number, maxAttempts = 12): Promise<MeetingRow[]> {
  await ensureBootstrapped();
  const r = await getPool().query<MeetingRow>(
    `UPDATE chat.fireflies_meetings m SET lease_until = now() + interval '3 minutes', attempts = m.attempts + 1,
        updated_at = now()
      WHERE m.meeting_id IN (
        SELECT meeting_id FROM chat.fireflies_meetings
         WHERE (pending_email OR pending_onedrive) AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until < now()) AND attempts < $2
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING m.*`,
    [limit, maxAttempts],
  );
  return r.rows;
}

/** Release the lease; schedule the next attempt if anything is still pending. */
export async function releaseMeeting(meetingId: string, retryInSec: number): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET lease_until = NULL,
        next_attempt_at = now() + make_interval(secs => $2), updated_at = now() WHERE meeting_id = $1`,
    [meetingId, retryInSec],
  );
}

export async function recordMeetingInfo(meetingId: string, title: string | null, meetingAt: string | null): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET title = COALESCE($2, title), meeting_at = COALESCE($3, meeting_at),
        updated_at = now() WHERE meeting_id = $1`,
    [meetingId, title, meetingAt],
  );
}

export async function recordEmailSent(
  meetingId: string,
  r: { source: string; kind: string; hash: string; recipients: string[] },
): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET email_status = 'sent', pending_email = false, minutes_source = $2,
        summary_kind = $3, content_hash = $4, email_recipients = $5, email_error = NULL, email_sent_at = now(),
        emails_sent = emails_sent + 1, updated_at = now() WHERE meeting_id = $1`,
    [meetingId, r.source, r.kind, r.hash, r.recipients],
  );
}

/** Nothing to email (a retry of sent minutes, or a resend while update emails are off). */
export async function recordEmailNotNeeded(meetingId: string): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET pending_email = false, updated_at = now() WHERE meeting_id = $1`,
    [meetingId],
  );
}

/** A failed or waiting attempt. `final` = stop trying (visible error stays). A previous successful send is
 *  never overwritten. */
export async function recordEmailProblem(
  meetingId: string,
  source: string,
  error: string,
  final: boolean,
): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET minutes_source = $2, email_error = $3,
        pending_email = CASE WHEN $4 THEN false ELSE pending_email END,
        email_status = CASE WHEN email_status = 'sent' THEN email_status
                            WHEN $4 THEN 'failed' ELSE email_status END,
        updated_at = now() WHERE meeting_id = $1`,
    [meetingId, source, error.slice(0, 200), final],
  );
}

export async function recordOneDrive(meetingId: string, r: { ok: boolean; path?: string; error?: string }): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.fireflies_meetings SET onedrive_status = $2, onedrive_path = COALESCE($3, onedrive_path),
       onedrive_error = $4, pending_onedrive = CASE WHEN $2 = 'saved' THEN false ELSE pending_onedrive END,
       updated_at = now() WHERE meeting_id = $1`,
    [meetingId, r.ok ? "saved" : "failed", r.path ?? null, r.ok ? null : (r.error ?? "failed").slice(0, 200)],
  );
}

export async function listRecentMeetings(owner: string, limit = 10): Promise<MeetingRow[]> {
  await ensureBootstrapped();
  const r = await getPool().query<MeetingRow>(
    `SELECT * FROM chat.fireflies_meetings WHERE owner_email = lower($1) ORDER BY created_at DESC LIMIT $2`,
    [owner, limit],
  );
  return r.rows;
}
