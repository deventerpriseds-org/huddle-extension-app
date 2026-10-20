// Web Push subscription lifecycle: register the service worker, and (on explicit user opt-in) request
// notification permission, subscribe with the server's VAPID key, and persist the subscription so the
// runner can notify this device when a reply lands while the app is backgrounded/closed.
import { useCallback, useEffect, useRef, useState } from "react";
import { getPushConfig, registerPushSubscription } from "../lib/huddle.functions";

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

export function usePush(caller: Caller) {
  const [supported] = useState(pushSupported);
  const [permission, setPermission] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "default"),
  );
  const [busy, setBusy] = useState(false);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  // Register the SW once so pushes can be delivered even when no tab is focused. Registration alone
  // does not prompt the user — the permission request happens only on explicit enablePush().
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        regRef.current = reg;
      })
      .catch(() => {});
  }, [supported]);

  // If permission is already granted, keep this device's subscription fresh on load.
  useEffect(() => {
    if (!supported || permission !== "granted" || !caller?.entra_email) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = regRef.current ?? (await navigator.serviceWorker.ready);
        // Permission granted but NO subscription is a real state, not an edge case: the bell asked
        // for permission while the server had no VAPID keys (prod, until 2026-10-19), so the subscribe
        // step bailed and nothing was ever saved. The bell then reads "on" while no push can arrive.
        // Subscribe here so that state heals on the next load instead of needing another tap.
        const sub = (await reg.pushManager.getSubscription()) ?? (await subscribeWithServerKey(reg));
        if (sub && !cancelled) await persist(sub, caller);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, permission, caller?.entra_email]); // eslint-disable-line react-hooks/exhaustive-deps

  const enablePush = useCallback(async (): Promise<boolean> => {
    if (!supported || busy) return false;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return false;
      const reg = regRef.current ?? (await navigator.serviceWorker.ready);
      const sub = (await reg.pushManager.getSubscription()) ?? (await subscribeWithServerKey(reg));
      if (!sub) return false;
      await persist(sub, caller);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported, busy, caller]);

  return { supported, permission, busy, enablePush };
}

/** Subscribe with the server's VAPID public key; null when the server has none configured. */
async function subscribeWithServerKey(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  const { vapidPublicKey } = await getPushConfig();
  if (!vapidPublicKey) return null;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}

async function persist(sub: PushSubscription, caller: Caller): Promise<void> {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
  await registerPushSubscription({
    data: {
      caller,
      subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    },
  });
}
