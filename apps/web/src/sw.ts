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

self.addEventListener("push", (event: PushEvent) => {
  let data: { type?: string; caller?: string; call_id?: string } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    // ignore malformed payloads
  }
  if (data.type !== "incoming-call") return;

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
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const callId = (event.notification.data as { call_id?: string })?.call_id;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const action = event.action || "open";
      for (const client of clients) {
        client.postMessage({ type: "call-notification", action, call_id: callId });
        await (client as WindowClient).focus();
        return;
      }
      // No open window — open the app; it will pick up the ringing call over WS.
      await self.clients.openWindow("/");
    })()
  );
});

// Apply updates as soon as the new worker is ready.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
