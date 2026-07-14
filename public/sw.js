// Huddle service worker — Web Push only (no offline caching). Lets a huddle reply that finishes while
// the user is away (screen off, app closed) buzz the phone. The server fires a push per finished turn;
// this SW suppresses the notification when a Huddle tab is already focused (the in-app delivery loop
// shows it there) and otherwise surfaces it. Clicking focuses/opens the app.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Huddle", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Huddle";
  const body = data.body || "";
  const url = data.url || "/";
  const tag = data.tag || "huddle";

  event.waitUntil(
    (async () => {
      // If a Huddle window is currently focused/visible, the user is present — let the in-app
      // delivery loop render the reply instead of double-notifying.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const present = wins.some((c) => c.focused || c.visibilityState === "visible");
      if (present) return;
      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        data: { url },
        icon: "/favicon.ico",
        badge: "/favicon.ico",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        if ("focus" in c) {
          await c.focus();
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
