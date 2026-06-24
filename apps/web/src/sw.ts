/// <reference lib="webworker" />
// Custom service worker: Workbox precaching + Web Push for incoming calls.
//
// On an incoming-call push we surface a notification with Accept/Decline. The
// instant in-app ring still comes over the WebSocket when the app is open; this
// push is what wakes a closed/backgrounded PWA on Android.
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Injected by vite-plugin-pwa at build time (the app shell to precache).
precacheAndRoute(self.__WB_MANIFEST || []);

interface PushPayload {
  type?: string;
  caller?: string;
  call_id?: string;
  // new-message
  from?: string;
  name?: string;
  id?: string;
  body?: string;
}

self.addEventListener("push", (event: PushEvent) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    // ignore malformed payloads
  }

  if (data.type === "incoming-call") {
    event.waitUntil(
      self.registration.showNotification(`Incoming call`, {
        body: `${data.caller || "Someone"} is calling you`,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: `call-${data.call_id || ""}`,
        requireInteraction: true,
        vibrate: [400, 200, 400, 200, 400],
        data: { call_id: data.call_id },
        actions: [
          { action: "accept", title: "Accept" },
          { action: "decline", title: "Decline" },
        ],
      } as NotificationOptions)
    );
    return;
  }

  if (data.type === "new-message") {
    event.waitUntil(handleMessagePush(data));
    return;
  }
});

// A new chat message: if the app is open and visible, hand it to the page for an
// in-app toast/badge and skip the system notification (Chrome exempts us from the
// "must show" rule while a client is focused). Otherwise surface a notification so
// a closed/backgrounded PWA still alerts the recipient.
async function handleMessagePush(data: PushPayload) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage({
      type: "chat-notification",
      from: data.from,
      name: data.name,
      id: data.id,
      body: data.body,
    });
  }
  const visible = clients.some((c) => c.visibilityState === "visible" || (c as WindowClient).focused);
  if (visible) return; // app is open & visible — in-app toast handles it

  await self.registration.showNotification(`New message${data.name ? ` from ${data.name}` : ""}`, {
    body: data.body || "You have a new message",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: `chat-${data.from || ""}`,
    data: { type: "new-message", from: data.from },
  } as NotificationOptions);
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const ndata = (event.notification.data as { type?: string; call_id?: string; from?: string }) || {};
  const isMessage = ndata.type === "new-message";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const action = event.action || "open";
      for (const client of clients) {
        client.postMessage(
          isMessage
            ? { type: "chat-notification", action: "open", from: ndata.from }
            : { type: "call-notification", action, call_id: ndata.call_id }
        );
        await (client as WindowClient).focus();
        return;
      }
      // No open window — open the app; it picks up the ring (WS) / chat on load.
      await self.clients.openWindow("/");
    })()
  );
});

// Apply updates as soon as the new worker is ready.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
