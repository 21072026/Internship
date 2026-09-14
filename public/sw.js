// Minimal service worker — enables installability and an offline-friendly
// shell. Network-first; falls back to cache when offline.
//
// The cache holds PUBLIC bytes only (#1550). See `mayCacheRequest` /
// `mayCacheResponse` below: a browser profile is not an account, so everything
// the cache holds has to be safe to hand to whoever opens this browser next.
//
// v4 (#1550): v3 cached every same-origin GET, authenticated JSON included, and
// never emptied itself on sign-out — so an offline navigation on a shared device
// could be answered out of another account's response. Bumping the name is what
// gets those bytes off already-installed clients: `activate` below deletes every
// cache that is not this one.
const CACHE = 'internship-crm-v4';
const OFFLINE_URL = '/offline';
// Public, account-independent, and the only two things precached: the offline
// fallback (so an un-visited page still degrades gracefully) and the icon it
// draws. Re-seeded after a purge, for the same reason.
const PRECACHE = [OFFLINE_URL, '/icon.svg'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Precache the offline fallback so even un-visited pages degrade gracefully.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// ── What may enter the cache (#1550) ────────────────────────────────────────
//
// Deny by default, and decide from the REQUEST and the RESPONSE rather than from
// a list of routes: a list only covers the routes that existed when it was
// written, and the next endpoint someone adds silently inherits the old
// behaviour. Two questions, neither of which needs to know a single URL:
//
//   1. Does the answer to this request depend on who is asking?
//      Everything under `/api/` does (it answers for whatever session cookie
//      was attached), and so does anything carrying an explicit `Authorization`
//      header. Those are never cached: the offline value of a stale
//      authenticated payload is negative, and the risk is a cross-account read.
//   2. Did the server itself say this response is not shareable?
//      A per-user render answers `Cache-Control: private, no-store` (Next's
//      default for a dynamic route) or varies on the cookie. Honouring that
//      keeps an authenticated *document* out of the cache too — the same defect
//      one layer up from `/api/`.
//
// What is left is the shell we actually want offline: `/_next/static/*`, icons,
// the manifest, `/offline`, and any genuinely public page the server marks as
// cacheable.
function mayCacheRequest(req) {
  if (!req || req.method !== 'GET') return false;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (req.headers && req.headers.get('authorization')) return false;
  return true;
}

function mayCacheResponse(res) {
  if (!res || !res.ok) return false;
  // `opaque` is a cross-origin no-cors response (nothing readable to match on)
  // and `error` is a failed fetch. Neither belongs in an offline shell.
  if (res.type === 'opaque' || res.type === 'error') return false;
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  const vary = (res.headers.get('vary') || '').toLowerCase();
  if (vary === '*' || vary.split(',').some((v) => v.trim() === 'cookie')) return false;
  if (res.headers.get('set-cookie')) return false;
  return true;
}

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

  const cacheable = mayCacheRequest(req);

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable && mayCacheResponse(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        // The same gate on the way out: a request we would never write is a
        // request we never answer from the cache either, whatever an older
        // worker version may have left lying around. Scoped to our own cache
        // for that reason — bare `caches.match()` searches every cache on the
        // origin, including one this version has not deleted yet.
        if (cacheable) {
          const cached = await caches
            .open(CACHE)
            .then((c) => c.match(req))
            .catch(() => undefined);
          if (cached) return cached;
        }
        // For navigations with nothing cached, show the offline page.
        if (req.mode === 'navigate') {
          const offline = await caches
            .open(CACHE)
            .then((c) => c.match(OFFLINE_URL))
            .catch(() => undefined);
          if (offline) return offline;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});

// ── Purge on sign-out (#1550) ───────────────────────────────────────────────
//
// A cache that survives a sign-out is the sharpest form of the bug above: the
// person who signs in next shares the browser profile, and therefore the cache.
// `signOutEverywhere()` (src/lib/signOutClient.ts) posts this message and waits
// for the ack before it redirects.
//
// Everything goes, not only this version's cache — and then the two public
// precached files are seeded again, so `/offline` keeps rendering after a
// sign-out instead of waiting for the next worker install.
async function purgeAllCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  try {
    const c = await caches.open(CACHE);
    await c.addAll(PRECACHE);
  } catch (e) {
    /* offline at sign-out time: the next install precaches it again */
  }
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type !== 'PURGE_CACHE') return;
  event.waitUntil(
    purgeAllCaches()
      .catch(() => {})
      .then(() => {
        // Ack down the MessagePort the page opened, so a sign-out can await the
        // purge instead of racing its own redirect.
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ type: 'PURGE_CACHE_DONE' });
      })
      .catch(() => {})
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
