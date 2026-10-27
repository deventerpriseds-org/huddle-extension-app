// WHAT:       The pure half of INSTANT new-email alerts: the Graph change-notification handshake, which
//             notifications to trust, when a subscription needs renewing, and whether "now" is inside
//             the owner's alert hours.
// WHY:        Owner, 2026-10-27: "i recieved an email and Iris did not immediately send me an alert".
//             Measured that day: Amy (Trinnex) arrived 13:39:48 ET, the 5-minute Inbox check picked it
//             up 13:43:03, push 13:43:11 — 3m23s, all of it the polling gap. A Graph subscription makes
//             Outlook call us the moment mail lands; the 5-minute check stays as the backstop.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:instant-email-alerts. Tests: bun scripts/mail-subscription.test.ts
//
// Only node:crypto — no server stack — so it is unit-testable under bun.

import { createHash, timingSafeEqual } from "node:crypto";

/** Graph caps an Outlook-message subscription at under 3 days for app-only basic notifications; ask
 *  for a little less and renew well before it lapses. */
export const MAIL_SUBSCRIPTION_MINUTES = 4200;
/** Renew when less than this is left, OR when the row is older than RENEW_EVERY_MS (catches a
 *  subscription Graph removed on its side, which we would otherwise never hear about). */
export const RENEW_WHEN_LEFT_MS = 24 * 3_600_000;
export const RENEW_EVERY_MS = 12 * 3_600_000;

/** The `clientState` Graph echoes on every notification. DERIVED from the existing shared
 *  JOURNEY_PROXY_TOKEN (standing rule: no new secret) so the raw token never leaves for Microsoft. */
export function mailClientState(proxyToken: string): string {
  return createHash("sha256").update(`huddle-graph-mail:${proxyToken}`).digest("hex").slice(0, 64);
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
}

/** The subscription ids whose notifications carry OUR clientState. Anything else — a forged POST, a
 *  stale subscription from another app — is dropped. Unique, in arrival order. */
export function trustedSubscriptionIds(body: unknown, expectedClientState: string): string[] {
  const value = (body as { value?: unknown })?.value;
  if (!Array.isArray(value) || !expectedClientState) return [];
  const out: string[] = [];
  for (const n of value as GraphNotification[]) {
    const id = typeof n?.subscriptionId === "string" ? n.subscriptionId.trim() : "";
    const cs = typeof n?.clientState === "string" ? n.clientState : "";
    if (!id || !cs || !sameString(cs, expectedClientState)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export interface StoredSubscription {
  subscription_id: string;
  expires_at: string | Date;
  updated_at: string | Date;
  notification_url: string;
}

/** What to do with the stored subscription for this owner on this run. */
export function subscriptionAction(
  row: StoredSubscription | null | undefined,
  notificationUrl: string,
  nowMs: number,
): "create" | "renew" | "keep" {
  if (!row) return "create";
  // A new deploy host means Graph is calling a URL that no longer serves us.
  if (row.notification_url !== notificationUrl) return "create";
  const left = new Date(row.expires_at).getTime() - nowMs;
  if (!Number.isFinite(left) || left <= 0) return "create";
  const age = nowMs - new Date(row.updated_at).getTime();
  if (left < RENEW_WHEN_LEFT_MS || !Number.isFinite(age) || age > RENEW_EVERY_MS) return "renew";
  return "keep";
}

/** Is `nowMs` inside the owner's alert hours? Same `hours` list the 5-minute check uses (the
 *  inboundEmail cadence, user-editable), so an email at 2am waits for the 7am check instead of
 *  buzzing the phone overnight. Fails OPEN on a bad time zone: a late alert beats a lost one. */
export function withinAlertHours(hours: number[], tz: string, nowMs: number): boolean {
  if (!Array.isArray(hours) || hours.length === 0) return true;
  try {
    const h = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
        new Date(nowMs),
      ),
    );
    return hours.includes(h);
  } catch {
    return true;
  }
}
