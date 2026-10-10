/* The browser's push receiver. It runs when no xMatrix page is open, shows what
   the Hub pushed (who wrote, what they said) and opens that conversation when
   the notification is clicked. It caches nothing and intercepts no requests. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function conversationPath(channelId) {
  // A canonical conversation link carries the Channel id after "--"; the app resolves the rest.
  return `/app/space/channels/channel--${encodeURIComponent(channelId)}`;
}

self.addEventListener("push", (event) => {
  let notification = {};
  try { notification = event.data ? event.data.json() : {}; } catch { notification = {}; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // An open page already tells its reader; the push is for when none is looking.
    if (windows.some((client) => client.visibilityState === "visible" && client.focused)) return;
    await self.registration.showNotification(String(notification.title || "xMatrix"), {
      body: String(notification.body || ""),
      tag: String(notification.channelId || "xmatrix"),
      icon: "/icon-192.png",
      badge: "/icon-48.png",
      data: { channelId: notification.channelId || null },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const channelId = event.notification.data && event.notification.data.channelId;
  const path = channelId ? conversationPath(channelId) : "/app";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).pathname.startsWith("/app"));
    if (open) {
      await open.focus();
      if ("navigate" in open) await open.navigate(path).catch(() => undefined);
      return;
    }
    await self.clients.openWindow(path);
  })());
});
