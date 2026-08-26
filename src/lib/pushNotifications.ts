'use client';

/**
 * Browser side of background Web Push (#1464, #675 Kademe 2).
 *
 * Everything here is best-effort and reversible: push is an extra channel on top
 * of the in-app bell, so a browser that cannot do it (no service worker, an iOS
 * Safari tab that has not been added to the home screen, a deployment with no
 * VAPID keys) must simply keep the foreground notifications it already had. No
 * function here throws.
 *
 * The permission prompt is deliberately NOT triggered from this module: iOS
 * silently ignores `requestPermission()` unless it is called inside a user
 * gesture, so the ask stays where it already is — the /account toggle's change
 * handler — and this module only runs once permission is in hand.
 */

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// base64url → bytes. `applicationServerKey` accepts a string in Chrome but not
// everywhere, so the conversion is not optional.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    // `register` is idempotent, and the only component that registers today is
    // the sidebar's install button — which is not on screen everywhere.
    await navigator.serviceWorker.register('/sw.js');
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/**
 * Subscribe this browser and hand the subscription to the server.
 * Returns true only when the server has stored it.
 */
export async function registerPushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const config = await fetch('/api/push/config').then((r) => (r.ok ? r.json() : null));
    if (!config?.enabled || !config.publicKey) return false;

    const registration = await readyRegistration();
    if (!registration) return false;

    // An existing subscription is reused rather than replaced: re-subscribing
    // would rotate the endpoint and orphan the row the server already has.
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource,
      }));

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Drop this browser's subscription, on the device and on the server. */
export async function unregisterPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription;
    // Server first: if the browser-side unsubscribe succeeds and the DELETE does
    // not, we would keep pushing to an endpoint nobody listens to.
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
    await subscription.unsubscribe().catch(() => false);
  } catch {
    /* best effort */
  }
}
