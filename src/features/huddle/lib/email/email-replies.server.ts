// WHAT:       The OWED / SETTLED ledger for emails Iris flagged: one row per announced email, holding
//             everything the reply buttons need (Graph message id, owner mailbox, the proposed reply),
//             so a tap hours later acts on stored context, never on chat text.
// WHY:        Owner, 2026-10-15: "it also needs a tracking component so that we know how many responses
//             are owed vs settled" and "this should have a yes or no button rather than depending on
//             text so that if i scroll up and click yes two hours later, the context to execute is
//             baked in". The card carries only `emailId`; this row is the truth.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:inbound-email-watch; tests: bun scripts/inbound-email.test.ts
//
// Status: owed -> drafted (a draft is saved, still owed until sent) -> replied | dismissed (settled).
// "replied" is detected from the owner's Sent Items (same Graph conversation, sent after receipt) on
// every inbound-email run, so settling needs no action in Huddle at all.
//
// Pool/bootstrap pattern copied from scheduling-config.server.ts.
import { Pool } from "pg";

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

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.email_replies (
  id               TEXT PRIMARY KEY,          -- shortHash(graph message id); also the alert turn id suffix
  owner_email      TEXT NOT NULL,             -- resolveTaskEmail(caller): the data-scope owner
  mailbox          TEXT NOT NULL,             -- the owner's Outlook mailbox the email arrived in
  graph_message_id TEXT NOT NULL,
  conversation_id  TEXT,
  from_address     TEXT,
  from_name        TEXT,
  subject          TEXT,
  received_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'owed',  -- owed | drafted | replied | dismissed
  proposed_reply   TEXT,
  draft_id         TEXT,
  draft_web_link   TEXT,
  settled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_replies_owner_status_idx ON chat.email_replies(owner_email, status);
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

export type EmailReplyStatus = "owed" | "drafted" | "replied" | "dismissed";
export const OWED_STATUSES: EmailReplyStatus[] = ["owed", "drafted"];

export interface EmailReplyRow {
  id: string;
  owner_email: string;
  mailbox: string;
  graph_message_id: string;
  conversation_id: string | null;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: string | null;
  status: EmailReplyStatus;
  proposed_reply: string | null;
  draft_id: string | null;
  draft_web_link: string | null;
  settled_at: string | null;
}

/** Record a flagged email as owed. Idempotent on id: a re-read of the same message never resets a
 *  row that has already moved on (drafted / settled). */
export async function recordOwedEmail(r: {
  id: string;
  ownerEmail: string;
  mailbox: string;
  graphMessageId: string;
  conversationId?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
}): Promise<void> {
  await ensureBootstrapped();
  await getPool().query(
    `INSERT INTO chat.email_replies
       (id, owner_email, mailbox, graph_message_id, conversation_id, from_address, from_name, subject, received_at)
     VALUES ($1, lower($2), lower($3), $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      r.id,
      r.ownerEmail,
      r.mailbox,
      r.graphMessageId,
      r.conversationId ?? null,
      r.fromAddress ?? null,
      r.fromName ?? null,
      r.subject ?? null,
      r.receivedAt ?? null,
    ],
  );
}

/** The row, only if it belongs to `ownerEmail`. Missing and not-yours are indistinguishable (null),
 *  so a guessed id cannot be used to probe — the same rule as getOwnedTaskForConfirmAsk. */
export async function getOwnedEmailReply(
  id: string,
  ownerEmail: string,
): Promise<EmailReplyRow | null> {
  await ensureBootstrapped();
  const r = await getPool().query<EmailReplyRow>(
    `SELECT * FROM chat.email_replies WHERE id = $1 AND owner_email = lower($2)`,
    [id, ownerEmail],
  );
  return r.rows[0] ?? null;
}

/** The newest still-owed email from `fromAddress` for this owner — how a revision with no id finds its row. */
export async function findOwedEmailReplyByFrom(
  ownerEmail: string,
  fromAddress: string,
): Promise<EmailReplyRow | null> {
  await ensureBootstrapped();
  const r = await getPool().query<EmailReplyRow>(
    `SELECT * FROM chat.email_replies
      WHERE owner_email = lower($1) AND lower(from_address) = lower($2) AND status IN ('owed','drafted')
      ORDER BY received_at DESC NULLS LAST LIMIT 1`,
    [ownerEmail, fromAddress.trim()],
  );
  return r.rows[0] ?? null;
}

export async function setProposedReply(
  id: string,
  ownerEmail: string,
  body: string,
): Promise<boolean> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `UPDATE chat.email_replies SET proposed_reply = $3, updated_at = now()
      WHERE id = $1 AND owner_email = lower($2)`,
    [id, ownerEmail, body],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markDrafted(
  id: string,
  draftId: string | null,
  webLink: string | null,
  body: string,
) {
  await ensureBootstrapped();
  await getPool().query(
    `UPDATE chat.email_replies
        SET status = CASE WHEN status = 'owed' THEN 'drafted' ELSE status END,
            draft_id = $2, draft_web_link = $3, proposed_reply = $4, updated_at = now()
      WHERE id = $1`,
    [id, draftId, webLink, body],
  );
}

/** Settle a row. Only an OWED row moves (a second tap / a race returns false = already settled). */
export async function settleEmailReply(id: string, how: "replied" | "dismissed"): Promise<boolean> {
  await ensureBootstrapped();
  const r = await getPool().query(
    `UPDATE chat.email_replies SET status = $2, settled_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('owed','drafted')`,
    [id, how],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listOwedEmailReplies(ownerEmail: string): Promise<EmailReplyRow[]> {
  await ensureBootstrapped();
  const r = await getPool().query<EmailReplyRow>(
    `SELECT * FROM chat.email_replies WHERE owner_email = lower($1) AND status IN ('owed','drafted')
      ORDER BY received_at ASC NULLS LAST`,
    [ownerEmail],
  );
  return r.rows;
}

/** Current status of each id that belongs to `ownerEmail` (others are simply absent, so a guessed id
 *  cannot probe). How the owed-digest card shows "already settled" on a row settled since it was sent. */
export async function getEmailReplyStatuses(
  ids: string[],
  ownerEmail: string,
): Promise<Record<string, EmailReplyStatus>> {
  if (!ids.length) return {};
  await ensureBootstrapped();
  const r = await getPool().query<{ id: string; status: EmailReplyStatus }>(
    `SELECT id, status FROM chat.email_replies WHERE owner_email = lower($2) AND id = ANY($1::text[])`,
    [ids, ownerEmail],
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, x.status]));
}

export interface EmailReplyCounts {
  owed: number;
  /** Of the owed, how many already have a draft saved (waiting on the owner to send). */
  drafted: number;
  settledToday: number;
  settledTotal: number;
}

/** Owed vs settled. "Today" is the owner's local day in `tz`. */
export async function getEmailReplyCounts(
  ownerEmail: string,
  tz = "America/New_York",
): Promise<EmailReplyCounts> {
  await ensureBootstrapped();
  const r = await getPool().query<{
    owed: string;
    drafted: string;
    settled_today: string;
    settled_total: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('owed','drafted'))                                    AS owed,
       count(*) FILTER (WHERE status = 'drafted')                                              AS drafted,
       count(*) FILTER (WHERE status IN ('replied','dismissed')
                          AND (settled_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS settled_today,
       count(*) FILTER (WHERE status IN ('replied','dismissed'))                               AS settled_total
     FROM chat.email_replies WHERE owner_email = lower($1)`,
    [ownerEmail, tz],
  );
  const x = r.rows[0];
  return {
    owed: Number(x?.owed ?? 0),
    drafted: Number(x?.drafted ?? 0),
    settledToday: Number(x?.settled_today ?? 0),
    settledTotal: Number(x?.settled_total ?? 0),
  };
}

/** Settle every owed row the owner has since answered from Outlook: he sent, after it arrived, a
 *  message in the same conversation OR any message to its sender (reply-match.ts). ONE Sent Items read
 *  per mailbox; if that read fails, falls back to the per-row conversation check. Never throws;
 *  returns how many it settled. Owner 2026-11-05: "self clear by checking if i replied ... for sure". */
export async function reconcileRepliedFromSentItems(ownerEmail: string): Promise<number> {
  let settled = 0;
  try {
    const owed = await listOwedEmailReplies(ownerEmail);
    if (!owed.length) return 0;
    const { hasSentReplyInConversation, listSentSince } = await import("./graph-email.server");
    const { answeredRowIds } = await import("./reply-match");
    const byMailbox = new Map<string, EmailReplyRow[]>();
    for (const r of owed) byMailbox.set(r.mailbox, [...(byMailbox.get(r.mailbox) ?? []), r]);
    for (const [mailbox, rows] of byMailbox) {
      const oldest = rows
        .map((r) => (r.received_at ? Date.parse(r.received_at) : NaN))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const since = new Date(oldest ?? Date.now() - 30 * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const sent = await listSentSince(mailbox, since);
      if (sent) {
        for (const id of answeredRowIds(rows, sent)) {
          if (await settleEmailReply(id, "replied")) settled++;
        }
        continue;
      }
      // Fallback: the old per-row conversation check.
      for (const row of rows) {
        if (!row.conversation_id) continue;
        const replied = await hasSentReplyInConversation(
          row.mailbox,
          row.conversation_id,
          row.received_at,
        );
        if (replied === true && (await settleEmailReply(row.id, "replied"))) settled++;
      }
    }
  } catch (err) {
    console.error("[email-replies] reconcile failed", err instanceof Error ? err.message : err);
  }
  return settled;
}
