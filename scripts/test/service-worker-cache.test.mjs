import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/sw.js decides, per request, what may be written to the Cache API — and
// that decision is a SECURITY rule, not a performance one (#1550): the Cache API
// is scoped to the browser profile, so anything the worker stores is readable by
// whoever signs in next on that device. The v3 worker cached every same-origin
// GET, authenticated JSON included, and never emptied itself on sign-out.
//
// WHY THIS TEST EXISTS AT ALL. `public/` is the one directory in this repo that
// nothing checks: `next lint` only visits `src/`, tsconfig's `include` only
// covers `*.ts|tsx`, and no bundler ever parses a file that is served verbatim.
// The e2e spec (e2e/sw-cache-scoping.spec.ts) drives a real worker in a real
// browser, but it needs a database and a Chromium and it only runs in the
// scheduled suite. So the rule itself is pinned here instead, in a runner that
// costs two seconds and runs on every PR: the worker script is evaluated inside
// a fake ServiceWorkerGlobalScope and its real `fetch` handler is handed
// synthetic requests.
//
// It asserts both directions, because both mistakes are silent:
//   - an authenticated response reaching the cache is the bug;
//   - a shell that stops being cached breaks the offline page for everyone, and
//     nothing else in CI would notice.
// The #1464 exclusions (/api/realtime/, text/event-stream — requests the worker
// must not respond to AT ALL) are pinned too, since "never cache an /api/ call"
// is one edit away from swallowing them.

const SW_PATH = path.join(process.cwd(), 'public/sw.js');
const ORIGIN = 'https://interncrm.com';

/** A Cache API stand-in: a Map of cache name → Map of url → Response. */
function fakeCacheStorage() {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const cacheFor = (name) => ({
    put: async (req, res) => {
      store(name).set(typeof req === 'string' ? new URL(req, ORIGIN).href : req.url, res);
    },
    addAll: async (urls) => {
      for (const u of urls) store(name).set(new URL(u, ORIGIN).href, new Response('precached'));
    },
    match: async (req) => {
      const url = typeof req === 'string' ? new URL(req, ORIGIN).href : req.url;
      return store(name).get(url);
    },
    keys: async () => [...store(name).keys()].map((url) => ({ url })),
  });
  return {
    open: async (name) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req) => {
      for (const name of stores.keys()) {
        const hit = await cacheFor(name).match(req);
        if (hit) return hit;
      }
      return undefined;
    },
    // Test-only view: every cached URL, across every cache.
    _urls: () => [...stores.values()].flatMap((m) => [...m.keys()]),
    _names: () => [...stores.keys()],
  };
}

/** Evaluate public/sw.js in a fake worker global and return a driver for it. */
function loadWorker() {
  const listeners = new Map();
  const caches = fakeCacheStorage();
  const harness = { fetchImpl: async () => new Response('net') };

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async () => {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    caches,
  };

  const sandbox = {
    self,
    caches,
    URL,
    Response,
    Request,
    Headers,
    fetch: (...args) => harness.fetchImpl(...args),
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'public/sw.js' });

  const pending = [];
  const dispatch = async (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
    await Promise.allSettled(pending.splice(0));
  };

  return {
    caches,
    harness,
    hasListener: (type) => (listeners.get(type) ?? []).length > 0,

    /**
     * Drive the fetch handler. Returns the response the worker produced, or
     * `undefined` when it declined to respond at all (a pass-through).
     */
    async fetch({ url, method = 'GET', headers = {}, mode = 'no-cors', respond, fail = false }) {
      const req = {
        url: new URL(url, ORIGIN).href,
        method,
        mode,
        headers: new Headers(headers),
      };
      harness.fetchImpl = async () => {
        if (fail) throw new Error('offline');
        return respond ? respond() : new Response('net', { status: 200 });
      };
      let responded;
      await dispatch('fetch', {
        request: req,
        respondWith: (p) => {
          responded = p;
        },
        waitUntil: (p) => pending.push(p),
      });
      if (responded === undefined) return undefined;
      const res = await responded;
      // The cache write is deliberately not awaited inside the handler (the
      // response must not wait on it), so let the microtask queue drain.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return res;
    },

    /** Post a message to the worker and resolve with the ack it sends back. */
    async message(data) {
      let ack;
      const port = { postMessage: (m) => { ack = m; } };
      await dispatch('message', {
        data,
        ports: [port],
        waitUntil: (p) => pending.push(p),
      });
      await new Promise((r) => setImmediate(r));
      return ack;
    },
  };
}

/** Response headers Next sends for a per-user (dynamic) render. */
const PRIVATE = { 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' };
/** …and for a static asset. */
const PUBLIC_IMMUTABLE = { 'cache-control': 'public, max-age=31536000, immutable' };

test('an authenticated API response is never written to the cache', async () => {
  const sw = loadWorker();
  const res = await sw.fetch({
    url: '/api/messages?threadId=abc',
    headers: { accept: 'application/json' },
    respond: () => new Response('{"messages":[{"body":"private"}]}', { status: 200 }),
  });
  assert.equal(await res.text(), '{"messages":[{"body":"private"}]}', 'still answered from the network');
  assert.deepEqual(sw.caches._urls(), [], 'nothing under /api/ may enter the cache');
});

test('no /api/ path is cached, whatever headers it answers with', async () => {
  const sw = loadWorker();
  // The rule is decided by what the request IS, not by a list of known routes —
  // so an endpoint that (wrongly, or as a public read) answers with cacheable
  // headers is still not cached, and neither is a route nobody has written yet.
  for (const url of ['/api/public/stats', '/api/v1/mentees', '/api/some/future/route', '/api']) {
    await sw.fetch({ url, respond: () => new Response('{}', { headers: PUBLIC_IMMUTABLE }) });
  }
  assert.deepEqual(sw.caches._urls(), []);
});

test('a response the server marked private is not cached either', async () => {
  const sw = loadWorker();
  // An authenticated *document* is the same defect one layer up from /api/:
  // /mentor renders one mentor's mentees into HTML. Next answers a dynamic
  // route with `private, no-store`, and the worker honours that.
  await sw.fetch({
    url: '/mentor',
    mode: 'navigate',
    respond: () => new Response('<html>mentee list</html>', { headers: PRIVATE }),
  });
  await sw.fetch({
    url: '/portal',
    mode: 'navigate',
    respond: () => new Response('<html>x</html>', { headers: { vary: 'Cookie' } }),
  });
  assert.deepEqual(sw.caches._urls(), []);
});

test('a request carrying an Authorization header is not cached', async () => {
  const sw = loadWorker();
  await sw.fetch({
    url: '/some/report.csv',
    headers: { authorization: 'Bearer sk-live-xxx' },
    respond: () => new Response('a,b,c', { headers: PUBLIC_IMMUTABLE }),
  });
  assert.deepEqual(sw.caches._urls(), []);
});

test('the public shell IS still cached (the offline page depends on it)', async () => {
  const sw = loadWorker();
  await sw.fetch({
    url: '/_next/static/chunks/main-abc.js',
    respond: () => new Response('console.log(1)', { headers: PUBLIC_IMMUTABLE }),
  });
  await sw.fetch({
    url: '/icon-192.png',
    respond: () => new Response('png', { headers: { 'cache-control': 'public, max-age=0' } }),
  });
  await sw.fetch({
    url: '/offline',
    mode: 'navigate',
    respond: () => new Response('<html>offline</html>', { headers: { 'cache-control': 'public, max-age=0' } }),
  });
  assert.deepEqual(sw.caches._urls().map((u) => new URL(u).pathname).sort(), [
    '/_next/static/chunks/main-abc.js',
    '/icon-192.png',
    '/offline',
  ]);
});

test('an error response is not cached', async () => {
  const sw = loadWorker();
  await sw.fetch({ url: '/nope', respond: () => new Response('gone', { status: 404 }) });
  assert.deepEqual(sw.caches._urls(), []);
});

test('offline, an /api/ request is answered 503 rather than from the cache', async () => {
  const sw = loadWorker();
  // Belt and braces: even if an older worker version left an /api/ entry behind
  // (v3 did, on every client that ever visited), this version will not serve it.
  const c = await sw.caches.open('internship-crm-v3');
  await c.put({ url: `${ORIGIN}/api/messages` }, new Response('{"stale":"other account"}'));

  const res = await sw.fetch({ url: '/api/messages', fail: true });
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'Offline');
});

test('offline, a navigation with nothing cached falls back to /offline', async () => {
  const sw = loadWorker();
  const c = await sw.caches.open('internship-crm-v4');
  await c.put({ url: `${ORIGIN}/offline` }, new Response('<html>offline</html>'));

  const res = await sw.fetch({ url: '/admin', mode: 'navigate', fail: true });
  assert.equal(await res.text(), '<html>offline</html>');
});

test('offline, a cached shell asset is served from the cache', async () => {
  const sw = loadWorker();
  await sw.fetch({
    url: '/_next/static/chunks/main-abc.js',
    respond: () => new Response('console.log(1)', { headers: PUBLIC_IMMUTABLE }),
  });
  const res = await sw.fetch({ url: '/_next/static/chunks/main-abc.js', fail: true });
  assert.equal(await res.text(), 'console.log(1)');
});

test('the #1464 realtime and SSE exclusions still pass straight through', async () => {
  const sw = loadWorker();
  // Not "not cached" — not RESPONDED TO. The worker must leave the open
  // EventSource entirely alone (see the comment in public/sw.js).
  assert.equal(await sw.fetch({ url: '/api/realtime/stream' }), undefined);
  assert.equal(
    await sw.fetch({ url: '/messages/live', headers: { accept: 'text/event-stream' } }),
    undefined
  );
  assert.deepEqual(sw.caches._urls(), []);
});

test('cross-origin and non-GET requests pass through', async () => {
  const sw = loadWorker();
  assert.equal(await sw.fetch({ url: 'https://example.com/x' }), undefined);
  assert.equal(await sw.fetch({ url: '/anything', method: 'POST' }), undefined);
  assert.deepEqual(sw.caches._urls(), []);
});

test('PURGE_CACHE empties every cache and acks, keeping only the public precache', async () => {
  const sw = loadWorker();
  const v4 = await sw.caches.open('internship-crm-v4');
  await v4.put({ url: `${ORIGIN}/mentor` }, new Response('<html>mentee list</html>'));
  const v3 = await sw.caches.open('internship-crm-v3');
  await v3.put({ url: `${ORIGIN}/api/messages` }, new Response('{}'));

  const ack = await sw.message({ type: 'PURGE_CACHE' });

  // `.type`, not a deep-equal on the object: the ack is constructed inside the
  // vm realm, so its prototype is not this realm's Object.
  assert.equal(ack?.type, 'PURGE_CACHE_DONE', 'the page waits for this before redirecting');
  assert.deepEqual(sw.caches._names(), ['internship-crm-v4'], 'the old version is gone entirely');
  // What is left is the two public files the offline fallback needs, re-seeded
  // so /offline keeps rendering after a sign-out.
  assert.deepEqual(sw.caches._urls().map((u) => new URL(u).pathname).sort(), ['/icon.svg', '/offline']);
});

test('an unrelated message does not purge anything', async () => {
  const sw = loadWorker();
  const c = await sw.caches.open('internship-crm-v4');
  await c.put({ url: `${ORIGIN}/icon.svg` }, new Response('svg'));
  assert.equal(await sw.message({ type: 'SOMETHING_ELSE' }), undefined);
  assert.equal(sw.caches._urls().length, 1);
});

test('the cache name is bumped past the version that cached /api responses', async () => {
  // Not decoration: `activate` deletes every cache whose name is not the
  // current one, so the name is the only thing that gets v3's authenticated
  // entries off a client that installed the old worker.
  const source = readFileSync(SW_PATH, 'utf8');
  const match = source.match(/const CACHE = 'internship-crm-v(\d+)'/);
  assert.ok(match, 'the cache name should stay in this shape');
  assert.ok(Number(match[1]) >= 4, 'v3 cached authenticated API responses — never go back to it');
});

test('the push handlers survived the edit', () => {
  const sw = loadWorker();
  for (const type of ['install', 'activate', 'fetch', 'message', 'push', 'notificationclick', 'pushsubscriptionchange']) {
    assert.ok(sw.hasListener(type), `public/sw.js should register a ${type} handler`);
  }
});
