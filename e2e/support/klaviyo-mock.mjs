// A stand-in for the Klaviyo API, used only by the e2e run (e2e/klaviyo-connector.spec.ts).
// Same trick as hibp-mock.mjs / google-mock.mjs: a local process that speaks the
// wire format the connector reads — JSON:API `data[]` + `links.next` with an
// opaque `page[cursor]`, `filter=greater-than(updated,…)`, `sort=updated`,
// `page[size]` ≤ 100, the `Klaviyo-API-Key` auth header, a required `revision`
// header, and 429 + `Retry-After` — so the app's half of the sync runs for real
// and no test ever calls the real provider.
//
// Data is per KEY: each key is its own "Klaviyo account", which is how the
// tenant-isolation test gives two organizations two different accounts.
//
// Control endpoints (never part of the real API):
//   POST /__account   { key, profiles?, lists? }  replace a key's account
//   POST /__profile   { key, profile }            add or replace one profile
//   POST /__ratelimit { key, count, retryAfter }  answer the next `count` data requests 429
//   POST /__reset                                 forget everything
//   GET  /__requests?key=…                        what the app asked (method + path)
//   GET  /__state                                 readiness probe
import { createServer } from 'node:http';

const PORT = Number(process.env.KLAVIYO_MOCK_PORT || 4603);

let accounts = new Map(); // key → { profiles: [], lists: [] }
let rateLimits = new Map(); // key → { count, retryAfter }
let requests = []; // { key, method, path }

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/vnd.api+json', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const encodeCursor = (offset) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor) {
  if (!cursor) return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return m ? Number(m[1]) : null;
}

function page(url, items, baseOrigin) {
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page[size]') || 20)));
  const offset = decodeCursor(url.searchParams.get('page[cursor]'));
  if (offset === null) return null;
  const slice = items.slice(offset, offset + size);
  let next = null;
  if (offset + size < items.length) {
    const n = new URL(url.pathname + url.search, baseOrigin);
    n.searchParams.set('page[cursor]', encodeCursor(offset + size));
    next = n.toString();
  }
  return { data: slice, links: { self: url.toString(), next, prev: null } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/__state') return json(res, 200, { ok: true });
    if (url.pathname === '/__reset') {
      accounts = new Map();
      rateLimits = new Map();
      requests = [];
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__account') {
      const body = await readBody(req);
      accounts.set(body.key, { profiles: body.profiles ?? [], lists: body.lists ?? [] });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__profile') {
      const body = await readBody(req);
      const account = accounts.get(body.key) ?? { profiles: [], lists: [] };
      account.profiles = [...account.profiles.filter((p) => p.id !== body.profile.id), body.profile];
      accounts.set(body.key, account);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__ratelimit') {
      const body = await readBody(req);
      rateLimits.set(body.key, { count: body.count ?? 1, retryAfter: body.retryAfter ?? 1 });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__requests') {
      const key = url.searchParams.get('key');
      return json(res, 200, { requests: requests.filter((r) => !key || r.key === key) });
    }

    // ── The API ──
    const auth = req.headers.authorization || '';
    const m = /^Klaviyo-API-Key (\S+)$/.exec(auth);
    const key = m ? m[1] : null;
    requests.push({ key, method: req.method, path: url.pathname + url.search, revision: req.headers.revision ?? null });
    if (!key || !accounts.has(key)) return json(res, 401, { errors: [{ status: 401, title: 'Not authenticated' }] });
    if (!req.headers.revision) return json(res, 400, { errors: [{ status: 400, title: 'Missing revision header' }] });
    if (req.method !== 'GET') return json(res, 405, { errors: [{ status: 405, title: 'Read-only stand-in' }] });
    const limit = rateLimits.get(key);
    if (limit && limit.count > 0) {
      limit.count -= 1;
      return json(res, 429, { errors: [{ status: 429, title: 'Throttled' }] }, { 'Retry-After': String(limit.retryAfter) });
    }
    const account = accounts.get(key);
    const origin = `http://127.0.0.1:${PORT}`;

    if (url.pathname === '/api/profiles') {
      let items = [...account.profiles];
      const filter = url.searchParams.get('filter');
      if (filter) {
        const f = /^greater-than\(updated,([^)]+)\)$/.exec(filter);
        if (!f) return json(res, 400, { errors: [{ status: 400, title: 'Unsupported filter' }] });
        const since = Date.parse(f[1]);
        items = items.filter((p) => Date.parse(p.attributes?.updated ?? '') > since);
      }
      if (url.searchParams.get('sort') === 'updated') {
        items.sort((a, b) => Date.parse(a.attributes.updated) - Date.parse(b.attributes.updated) || a.id.localeCompare(b.id));
      }
      const withSubs = url.searchParams.get('additional-fields[profile]') === 'subscriptions';
      if (!withSubs) items = items.map((p) => ({ ...p, attributes: { ...p.attributes, subscriptions: undefined } }));
      const body = page(url, items, origin);
      if (!body) return json(res, 400, { errors: [{ status: 400, title: 'Invalid cursor' }] });
      return json(res, 200, body);
    }
    if (url.pathname === '/api/lists') {
      const lists = account.lists.map((l) => ({ type: 'list', id: l.id, attributes: { name: l.name } }));
      const body = page(new URL(`${url.pathname}?${url.searchParams}&page[size]=10`, origin), lists, origin);
      return json(res, 200, body ?? { data: [], links: { next: null } });
    }
    return json(res, 404, { errors: [{ status: 404, title: 'Not found' }] });
  } catch (e) {
    return json(res, 500, { errors: [{ status: 500, title: String(e) }] });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`klaviyo mock listening on http://127.0.0.1:${PORT}`);
});
