// Service-worker registration + Web Push subscription.
//
// Push only functions in a production build served over HTTPS (the dev server
// ships no service worker). Everything here degrades to a no-op when the browser
// lacks support, the user denies permission, or no VAPID key is configured.
import { pushApi } from "./api";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let registered = false;

/** Register the SW and subscribe to push. Safe to call repeatedly. */
export async function setupPush(): Promise<void> {
  if (registered) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { type: "module" });
  } catch {
    return; // no SW (e.g. dev server) — nothing to do
  }
  registered = true;

  // Forward SW notification clicks (Accept/Decline) to the app.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "call-notification") {
      window.dispatchEvent(new CustomEvent("call-notification", { detail: e.data }));
    }
  });

  let key: string;
  try {
    key = (await pushApi.publicKey()).public_key;
  } catch {
    return;
  }
  if (!key) return; // server has no VAPID key configured

  if (Notification.permission === "default") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
  }
  if (Notification.permission !== "granted") return;

  try {
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));
    await pushApi.subscribe(sub.toJSON() as PushSubscriptionJSON);
  } catch {
    // subscription failed — ignore; in-app WS ringing still works
  }
}
