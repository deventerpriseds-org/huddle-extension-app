// Server-side Web Push sender. When a turn finishes on the runner and the user is away (screen off,
// app closed), we buzz their phone via any Web Push subscriptions they've registered. VAPID keys come
// from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT); if they're unset push is simply a
// no-op (the durable turn + deliver-on-reconnect still works — push is the extra "know while away").
import webpush from "web-push";
import {
  getPushSubscriptions,
  deletePushSubscription,
  type PushSubscriptionRecord,
} from "../tasks/turns.server";

let vapidReady: boolean | null = null;
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:huddle@enterpriseds.io";
  if (!pub || !priv) {
    vapidReady = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidReady = true;
  } catch {
    vapidReady = false;
  }
  return vapidReady;
}

/** The public VAPID key the browser needs to create a subscription (safe to expose). */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Fan a notification out to every device the user has subscribed. Dead endpoints (404/410 Gone) are
 * pruned. Never throws — push is best-effort and must not fail the turn.
 */
export async function sendPushToUser(userEmail: string | null | undefined, payload: PushPayload): Promise<void> {
  if (!userEmail) return;
  if (!ensureVapid()) return;
  let subs: PushSubscriptionRecord[];
  try {
    subs = await getPushSubscriptions(userEmail);
  } catch {
    return;
  }
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await deletePushSubscription(s.endpoint).catch(() => {});
        }
      }
    }),
  );
}
