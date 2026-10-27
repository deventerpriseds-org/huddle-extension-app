// WHAT:       Keeps ONE Microsoft Graph change-notification subscription alive on the owner's Outlook
//             Inbox, so a new email reaches /api/public/graph-mail-notify within seconds.
// WHY:        See mail-subscription.ts — the 3m23s gap on 2026-10-27 was entirely the 5-minute poll.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:instant-email-alerts.
//
// EXTENDS THE INBOUND EMAIL WATCH, does not replace it: the 5-minute check calls ensureMailSubscription
// (so the subscription is created and renewed with no new cron), and every notification just runs the
// same runInboundEmailWatch. Each email is still announced once ever (its turn id), so a notification
// and a poll that both see one message send one alert. No new secret: clientState is derived from
// JOURNEY_PROXY_TOKEN. Table chat.graph_mail_subscriptions is new because nothing stored Graph
// subscriptions before (push_subscriptions is web-push/FCM devices, a different thing).

import { Pool } from "pg";
import {
  MAIL_SUBSCRIPTION_MINUTES,
  mailClientState,
  subscriptionAction,
} from "./mail-subscription";

// Pool/bootstrap pattern copied from email-replies.server.ts.
let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.graph_mail_subscriptions (
  owner_email      TEXT PRIMARY KEY,
  caller_email     TEXT NOT NULL,
  mailbox          TEXT NOT NULL,
  subscription_id  TEXT NOT NULL UNIQUE,
  notification_url TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
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

/** The public URL Graph calls. Same base resolution as the scheduler's self-POST. */
export function mailNotificationUrl(): string | null {
  const raw =
    (process.env.HUDDLE_APP_URL ?? "").trim() ||
    (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : "");
  const base = raw.replace(/\/$/, "");
  return base ? `${base}/api/public/graph-mail-notify` : null;
}

export interface EnsureResult {
  action: "create" | "renew" | "keep" | "skipped";
  ok: boolean;
  /** Graph status code only — the raw text can echo the mailbox, and run results reach public logs. */
  status?: number;
}

/**
 * Make sure the owner's Inbox subscription exists and is fresh. Cheap when nothing is due (one indexed
 * read). NEVER THROWS: instant alerts are an accelerator; the 5-minute check works without them.
 */
export async function ensureMailSubscription(input: {
  ownerEmail: string;
  callerEmail: string;
  mailbox: string;
  nowMs?: number;
}): Promise<EnsureResult> {
  try {
    const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
    const url = mailNotificationUrl();
    if (!token || !url) return { action: "skipped", ok: false };
    await ensureBootstrapped();
    const owner = input.ownerEmail.trim().toLowerCase();
    const nowMs = input.nowMs ?? Date.now();
    const { rows } = await getPool().query(
      `SELECT * FROM chat.graph_mail_subscriptions WHERE owner_email = $1`,
      [owner],
    );
    const row = rows[0] ?? null;
    let action = subscriptionAction(row, url, nowMs);
    if (action === "keep") return { action, ok: true };

    const { getAppToken } = await import("./graph-email.server");
    const auth = {
      Authorization: `Bearer ${await getAppToken()}`,
      "Content-Type": "application/json",
    };
    const expirationDateTime = new Date(nowMs + MAIL_SUBSCRIPTION_MINUTES * 60_000).toISOString();

    if (action === "renew") {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(row.subscription_id)}`,
        { method: "PATCH", headers: auth, body: JSON.stringify({ expirationDateTime }) },
      );
      if (res.ok) {
        await getPool().query(
          `UPDATE chat.graph_mail_subscriptions SET expires_at = $2, updated_at = now() WHERE owner_email = $1`,
          [owner, expirationDateTime],
        );
        return { action, ok: true };
      }
      // Gone on Graph's side (404) or otherwise unrenewable: make a new one below.
      console.error("[mail-subscription] renew failed", res.status);
      action = "create";
    }

    if (row) {
      // Best-effort: retire the old one so Graph is not calling a dead URL with our clientState.
      await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(row.subscription_id)}`,
        { method: "DELETE", headers: auth },
      ).catch(() => {});
    }
    // Graph POSTs a validationToken to `url` before answering this call; graph-mail-notify echoes it.
    const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: url,
        resource: `users/${input.mailbox}/mailFolders('inbox')/messages`,
        expirationDateTime,
        clientState: mailClientState(token),
      }),
    });
    if (res.status !== 201) {
      console.error(
        "[mail-subscription] create failed",
        res.status,
        (await res.text()).slice(0, 300),
      );
      return { action, ok: false, status: res.status };
    }
    const sub = (await res.json()) as { id: string; expirationDateTime?: string };
    await getPool().query(
      `INSERT INTO chat.graph_mail_subscriptions
         (owner_email, caller_email, mailbox, subscription_id, notification_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_email) DO UPDATE SET
         caller_email = EXCLUDED.caller_email, mailbox = EXCLUDED.mailbox,
         subscription_id = EXCLUDED.subscription_id, notification_url = EXCLUDED.notification_url,
         expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [
        owner,
        input.callerEmail,
        input.mailbox,
        sub.id,
        url,
        sub.expirationDateTime ?? expirationDateTime,
      ],
    );
    return { action, ok: true };
  } catch (err) {
    console.error("[mail-subscription] ensure crashed", err instanceof Error ? err.message : err);
    return { action: "skipped", ok: false };
  }
}

/** The caller each trusted subscription belongs to (unknown ids are simply absent). */
export async function callersForSubscriptions(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  await ensureBootstrapped();
  const { rows } = await getPool().query(
    `SELECT DISTINCT caller_email FROM chat.graph_mail_subscriptions WHERE subscription_id = ANY($1)`,
    [ids],
  );
  return rows.map((r: { caller_email: string }) => r.caller_email);
}
