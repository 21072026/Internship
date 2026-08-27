// Minimal service worker — enables installability and an offline-friendly
// shell. Network-first; falls back to cache when offline.
const CACHE = 'internship-crm-v3';
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Precache the offline fallback so even un-visited pages degrade gracefully.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE_URL, '/icon.svg']).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GET navigations/assets; let the rest pass through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Never touch the live message stream (#1464). It is a GET that stays open for
  // half an hour, so the cache-on-the-way-past below would hold its whole body in
  // memory and, worse, a later offline hit would answer an EventSource with a
  // finite replay of an old stream — which reads as "connection closed" and turns
  // into a reconnect loop.
  if (new URL(req.url).pathname.startsWith('/api/realtime/')) return;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // For navigations with nothing cached, show the offline page.
        if (req.mode === 'navigate') {
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});

// ---------------------------------------------------------------------------
// Web Push (#1464, #675 Kademe 2).
//
// This is the half of "notify me when a message arrives" that works with the app
// closed: the push service wakes this worker, and the worker — not a page — shows
// the notification. `showNotification` is mandatory here, not optional: a browser
// that receives a `userVisibleOnly` push and shows nothing eventually revokes the
// subscription, so the catch below still posts a generic notification rather than
// swallowing a malformed payload.
// ---------------------------------------------------------------------------

const DEFAULT_PUSH_TITLE = 'Internship CRM';

// The VAPID key travels as base64url text; `pushManager.subscribe` wants bytes.
// Chrome accepts the string form, others do not — so convert, always.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = self.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  const title = payload.title || DEFAULT_PUSH_TITLE;
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Same tag = the newer notification replaces the older one, so ten messages
    // in one thread are one line in the tray instead of ten.
    tag: payload.tag || 'message',
    renotify: true,
    data: { url: payload.url || '/messages' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/messages';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer focusing a tab we already have and navigating it: opening a new
      // window per notification is how you end up with nine copies of the inbox.
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        return client.focus().then((focused) => {
          if (focused && 'navigate' in focused) return focused.navigate(target).catch(() => undefined);
          return undefined;
        });
      }
      return self.clients.openWindow(target);
    })
  );
});

// The push service can rotate a subscription out from under us. Re-subscribing
// here (and telling the server) is what keeps notifications arriving instead of
// silently stopping until the user next visits /account.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/api/push/config');
        if (!res.ok) return;
        const { enabled, publicKey } = await res.json();
        if (!enabled || !publicKey) return;
        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        });
      } catch (e) {
        /* nothing useful to do from a worker with no UI */
      }
    })()
  );
});
