// A stand-in for the Klaviyo API, used only by the e2e run (e2e/klaviyo-connector.spec.ts).
// Same trick as hibp-mock.mjs / google-mock.mjs: a local process that speaks the
// wire format the connector reads — JSON:API `data[]` + `links.next` with an
// opaque `page[cursor]`, `filter=greater-than(updated,…)`, `sort=updated`,
// `page[size]` ≤ 100, the `Klaviyo-API-Key` auth header, a required `revision`
// header, and 429 + `Retry-After` — so the app's half of the sync runs for real
// and no test ever calls the real provider. Beyond profiles it serves lists,
// segments and their members, metrics, events (per metric, by datetime),
// campaigns with their messages as `included[]`, flows, and the reporting
// API's one read-only POST (`/api/campaign-values-reports`); every other
// non-GET answers 405.
//
// Data is per KEY: each key is its own "Klaviyo account", which is how the
// tenant-isolation test gives two organizations two different accounts.
//
// Control endpoints (never part of the real API):
//   POST /__account   { key, profiles?, lists?, segments?, members?, metrics?,
//                       events?, campaigns?, flows?, report? }   replace a key's account
//                     (members: { <list or segment id>: [{ id, joined_group_at }] },
//                      campaigns: [{ id, name, updated_at, messages: [{ id, name, status }] }],
//                      report: [{ groupings, statistics }])
//   POST /__profile   { key, profile }            add or replace one profile
//   POST /__ratelimit { key, count, retryAfter }  answer the next `count` data requests 429
//   POST /__forbid    { key, paths: [...] }       answer 403 on these paths (a missing scope)
//   POST /__reset                                 forget everything
//   GET  /__requests?key=…                        what the app asked (method + path)
//   GET  /__state                                 readiness probe
import { createServer } from 'node:http';

const PORT = Number(process.env.KLAVIYO_MOCK_PORT || 4603);

let accounts = new Map(); // key → { profiles: [], lists: [], segments: [], … }
let rateLimits = new Map(); // key → { count, retryAfter }
let forbidden = new Map(); // key → Set of paths answered 403
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

function page(url, items, baseOrigin, max = 100) {
  const size = Math.min(max, Math.max(1, Number(url.searchParams.get('page[size]') || 20)));
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
      forbidden = new Map();
      requests = [];
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__account') {
      const body = await readBody(req);
      accounts.set(body.key, {
        profiles: body.profiles ?? [],
        lists: body.lists ?? [],
        segments: body.segments ?? [],
        members: body.members ?? {},
        metrics: body.metrics ?? [],
        events: body.events ?? [],
        campaigns: body.campaigns ?? [],
        flows: body.flows ?? [],
        report: body.report ?? [],
      });
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
    if (url.pathname === '/__forbid') {
      const body = await readBody(req);
      forbidden.set(body.key, new Set(body.paths ?? []));
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
    const isReportQuery = req.method === 'POST' && url.pathname === '/api/campaign-values-reports';
    if (req.method !== 'GET' && !isReportQuery) return json(res, 405, { errors: [{ status: 405, title: 'Read-only stand-in' }] });
    const limit = rateLimits.get(key);
    if (limit && limit.count > 0) {
      limit.count -= 1;
      return json(res, 429, { errors: [{ status: 429, title: 'Throttled' }] }, { 'Retry-After': String(limit.retryAfter) });
    }
    if (forbidden.get(key)?.has(url.pathname)) return json(res, 403, { errors: [{ status: 403, title: 'Missing scope' }] });
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
    // `greater-than(<field>,<iso>)` and `equals(metric_id,"X")`, comma-joined.
    // Parsed by plain string splitting — no regex over the request's text.
    const filters = (url.searchParams.get('filter') || '')
      .split('),')
      .map((part) => {
        const open = part.indexOf('(');
        const comma = part.indexOf(',', open);
        if (open < 1 || comma < 0) return null;
        const value = part.slice(comma + 1).replace(/\)$/, '');
        return { op: part.slice(0, open), field: part.slice(open + 1, comma), value: value.replace(/^"|"$/g, '') };
      })
      .filter(Boolean);
    const after = (field) => {
      const f = filters.find((x) => x.op === 'greater-than' && x.field === field);
      return f ? Date.parse(f.value) : null;
    };
    const since = (items, field) => {
      const t = after(field);
      return t === null ? items : items.filter((i) => Date.parse(i.attributes?.[field] ?? '') > t);
    };
    const serve = (items, max) => {
      const body = page(url, items, origin, max);
      return body ? json(res, 200, body) : json(res, 400, { errors: [{ status: 400, title: 'Invalid cursor' }] });
    };

    if (url.pathname === '/api/lists') {
      const lists = account.lists.map((l) => ({ type: 'list', id: l.id, attributes: { name: l.name, updated: l.updated ?? '2026-01-01T00:00:00Z' } }));
      return serve(since(lists, 'updated'), 10);
    }
    if (url.pathname === '/api/segments') {
      const segs = account.segments.map((g) => ({ type: 'segment', id: g.id, attributes: { name: g.name, is_active: true, updated: g.updated ?? '2026-01-01T00:00:00Z' } }));
      return serve(since(segs, 'updated'), 10);
    }
    const members = /^\/api\/(lists|segments)\/([^/]+)\/profiles$/.exec(url.pathname);
    if (members) {
      const group = (members[1] === 'lists' ? account.lists : account.segments).find((g) => g.id === members[2]);
      if (!group) return json(res, 404, { errors: [{ status: 404, title: 'Not found' }] });
      const items = (account.members[members[2]] ?? [])
        .map((m) => ({ type: 'profile', id: m.id, attributes: { joined_group_at: m.joined_group_at } }))
        .sort((a, b) => Date.parse(a.attributes.joined_group_at) - Date.parse(b.attributes.joined_group_at));
      return serve(since(items, 'joined_group_at'), 100);
    }
    if (url.pathname === '/api/metrics') {
      return serve(account.metrics.map((m) => ({ type: 'metric', id: m.id, attributes: { name: m.name, integration: { name: 'Klaviyo', category: 'Internal' } } })), 200);
    }
    if (url.pathname === '/api/events') {
      const metric = filters.find((x) => x.op === 'equals' && x.field === 'metric_id')?.value;
      if (!metric) return json(res, 400, { errors: [{ status: 400, title: 'metric_id filter expected' }] });
      const items = account.events
        .filter((e) => e.metric === metric)
        .map((e) => ({
          type: 'event',
          id: e.id,
          attributes: { datetime: e.datetime, event_properties: e.properties ?? {} },
          relationships: { metric: { data: { type: 'metric', id: e.metric } }, profile: { data: e.profile ? { type: 'profile', id: e.profile } : null } },
        }))
        .sort((a, b) => Date.parse(a.attributes.datetime) - Date.parse(b.attributes.datetime));
      return serve(since(items, 'datetime'), 200);
    }
    if (url.pathname === '/api/campaigns') {
      const items = account.campaigns.map((c) => ({
        type: 'campaign',
        id: c.id,
        attributes: { updated_at: c.updated_at, created_at: c.updated_at, definition: { name: c.name, archived: false } },
        relationships: { 'campaign-messages': { data: (c.messages ?? []).map((m) => ({ type: 'campaign-message', id: m.id })) } },
      }));
      const body = page(url, since(items, 'updated_at'), origin, 100);
      if (!body) return json(res, 400, { errors: [{ status: 400, title: 'Invalid cursor' }] });
      if (url.searchParams.get('include') === 'campaign-messages') {
        const ids = new Set(body.data.map((c) => c.id));
        body.included = account.campaigns
          .filter((c) => ids.has(c.id))
          .flatMap((c) => (c.messages ?? []).map((m) => ({ type: 'campaign-message', id: m.id, attributes: { definition: { name: m.name, status: m.status } } })));
      }
      return json(res, 200, body);
    }
    if (url.pathname === '/api/flows') {
      const items = account.flows.map((f) => ({ type: 'flow', id: f.id, attributes: { name: f.name, status: f.status ?? 'live', archived: false, trigger_type: 'Added to List', updated: f.updated ?? '2026-01-01T00:00:00Z' } }));
      return serve(since(items, 'updated'), 50);
    }
    if (isReportQuery) {
      const body = await readBody(req);
      const attrs = body?.data?.attributes ?? {};
      if (body?.data?.type !== 'campaign-values-report' || !attrs.conversion_metric_id || !Array.isArray(attrs.statistics)) {
        return json(res, 400, { errors: [{ status: 400, title: 'Invalid report query' }] });
      }
      return json(res, 200, { data: { type: 'campaign-values-report', attributes: { results: account.report } }, links: { next: null } });
    }
    return json(res, 404, { errors: [{ status: 404, title: 'Not found' }] });
  } catch (e) {
    return json(res, 500, { errors: [{ status: 500, title: String(e) }] });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`klaviyo mock listening on http://127.0.0.1:${PORT}`);
});
