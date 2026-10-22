// Unit tests for the Klaviyo HTTP client (src/lib/klaviyoClient.ts) with an
// injected fetch: the headers it sends, the revision it names, cursor
// pagination over `links.next`, the 429 / 5xx retry and backoff, the network
// failure path, and the rule that the only POST is the reporting query.
// No request leaves the process. Run:
//   node --test --experimental-strip-types scripts/test/klaviyo-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { klaviyoGet, klaviyoQuery, fetchResourcePage, klaviyoRevision, KLAVIYO_QUERY_POST_PATHS } = await import('../../src/lib/klaviyoClient.ts');
const { KLAVIYO_REVISION, KLAVIYO_MAX_ATTEMPTS } = await import('../../src/lib/klaviyoRule.ts');

// A synthetic key — never a real one.
const KEY = 'pk_test_000000000000000000000000';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/vnd.api+json', ...headers } });
}

/** A fetch that answers from a script, recording every call. */
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('no scripted answer left');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetchImpl, calls };
}

function recordingSleep() {
  const waits = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}

test('every request carries the auth header, JSON:API accept and the default revision; the key is not in the URL', async () => {
  const { fetchImpl, calls } = scripted([jsonResponse(200, { data: [] })]);
  const res = await klaviyoGet('/api/lists?fields[list]=name', KEY, { fetchImpl });
  assert.equal(res.ok, true);
  const { url, init } = calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, `Klaviyo-API-Key ${KEY}`);
  assert.equal(init.headers.Accept, 'application/vnd.api+json');
  assert.equal(init.headers.revision, KLAVIYO_REVISION);
  assert.equal(init.redirect, 'error');
  assert.ok(!url.includes(KEY));
});

test('KLAVIYO_REVISION pins another GA date; a .pre revision or junk falls back to the default', () => {
  const prev = process.env.KLAVIYO_REVISION;
  try {
    process.env.KLAVIYO_REVISION = '2026-07-15';
    assert.equal(klaviyoRevision(), '2026-07-15');
    process.env.KLAVIYO_REVISION = '2026-10-15.pre';
    assert.equal(klaviyoRevision(), KLAVIYO_REVISION);
    process.env.KLAVIYO_REVISION = 'latest';
    assert.equal(klaviyoRevision(), KLAVIYO_REVISION);
    process.env.KLAVIYO_REVISION = '2024-10-15'; // older than anything this code was checked against
    assert.equal(klaviyoRevision(), KLAVIYO_REVISION);
  } finally {
    if (prev === undefined) delete process.env.KLAVIYO_REVISION;
    else process.env.KLAVIYO_REVISION = prev;
  }
});

test('cursor pagination: links.next yields its page[cursor]; the last page yields null', async () => {
  const { fetchImpl } = scripted([
    jsonResponse(200, {
      data: [{ type: 'list', id: 'L1' }],
      links: { next: 'https://a.klaviyo.com/api/lists?page%5Bcursor%5D=abc123' },
    }),
    jsonResponse(200, { data: [{ type: 'list', id: 'L2' }], included: [{ type: 'x', id: '1' }], links: { next: null } }),
  ]);
  const first = await fetchResourcePage('/api/lists', KEY, { fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.data.nextCursor, 'abc123');
  assert.deepEqual(first.data.included, []);
  const second = await fetchResourcePage('/api/lists?page[cursor]=abc123', KEY, { fetchImpl });
  assert.equal(second.data.nextCursor, null);
  assert.equal(second.data.included.length, 1);
});

test('a page that is not JSON:API is bad_response, not a crash', async () => {
  const { fetchImpl } = scripted([jsonResponse(200, { nope: true })]);
  const res = await fetchResourcePage('/api/lists', KEY, { fetchImpl });
  assert.deepEqual(res, { ok: false, code: 'bad_response' });
});

test('429 with a short Retry-After is waited out, then the request succeeds', async () => {
  const { fetchImpl, calls } = scripted([jsonResponse(429, { errors: [] }, { 'Retry-After': '2' }), jsonResponse(200, { data: [] })]);
  const { sleep, waits } = recordingSleep();
  const res = await klaviyoGet('/api/metrics', KEY, { fetchImpl, sleep });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test('429 with a long Retry-After gives up at once and hands the wait to the run', async () => {
  const { fetchImpl, calls } = scripted([jsonResponse(429, { errors: [] }, { 'Retry-After': '120' })]);
  const { sleep, waits } = recordingSleep();
  const res = await klaviyoGet('/api/metrics', KEY, { fetchImpl, sleep });
  assert.deepEqual(res, { ok: false, code: 'rate_limited', status: 429, retryAfterMs: 120_000 });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('5xx backs off exponentially and stops after KLAVIYO_MAX_ATTEMPTS', async () => {
  const answers = Array.from({ length: KLAVIYO_MAX_ATTEMPTS }, () => jsonResponse(503, { errors: [] }));
  const { fetchImpl, calls } = scripted(answers);
  const { sleep, waits } = recordingSleep();
  const res = await klaviyoGet('/api/flows', KEY, { fetchImpl, sleep });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'upstream_error');
  assert.equal(calls.length, KLAVIYO_MAX_ATTEMPTS);
  assert.equal(waits.length, KLAVIYO_MAX_ATTEMPTS - 1);
  // 1 s, 2 s, 4 s, each ±25 %.
  [1000, 2000, 4000].forEach((base, i) => assert.ok(waits[i] >= base * 0.75 && waits[i] <= base * 1.25, `wait ${i}: ${waits[i]}`));
});

test('a 5xx that recovers on the second try succeeds', async () => {
  const { fetchImpl } = scripted([jsonResponse(500, {}), jsonResponse(200, { data: [] })]);
  const { sleep } = recordingSleep();
  assert.equal((await klaviyoGet('/api/flows', KEY, { fetchImpl, sleep })).ok, true);
});

test('401 / 403 / 400 are not retried', async () => {
  for (const [status, code] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [400, 'bad_request'],
  ]) {
    const { fetchImpl, calls } = scripted([jsonResponse(status, { errors: [] })]);
    const res = await klaviyoGet('/api/events', KEY, { fetchImpl, sleep: async () => {} });
    assert.equal(res.code, code);
    assert.equal(calls.length, 1);
  }
});

test('a network failure (timeout, refused) is retried, then reported as network', async () => {
  const fail = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const { fetchImpl, calls } = scripted(Array.from({ length: KLAVIYO_MAX_ATTEMPTS }, fail));
  const res = await klaviyoGet('/api/events', KEY, { fetchImpl, sleep: async () => {} });
  assert.deepEqual(res, { ok: false, code: 'network' });
  assert.equal(calls.length, KLAVIYO_MAX_ATTEMPTS);
});

test('every request is bounded by a timeout signal', async () => {
  const { fetchImpl, calls } = scripted([jsonResponse(200, { data: [] })]);
  await klaviyoGet('/api/events', KEY, { fetchImpl });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('the only POST is a reporting query; any other path throws before a request', async () => {
  assert.deepEqual([...KLAVIYO_QUERY_POST_PATHS], ['/api/campaign-values-reports']);
  const { fetchImpl, calls } = scripted([jsonResponse(200, { data: { attributes: { results: [] } } })]);
  const res = await klaviyoQuery('/api/campaign-values-reports', KEY, { data: { type: 'campaign-values-report' } }, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/vnd.api+json');
  for (const path of ['/api/profiles', '/api/profile-import', '/api/lists/L1/relationships/profiles', '/api/events']) {
    await assert.rejects(() => klaviyoQuery(path, KEY, {}, { fetchImpl }), /not a read-only query endpoint/);
  }
  assert.equal(calls.length, 1);
});

test('requests of one family are paced', async () => {
  const { fetchImpl } = scripted([jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] })]);
  const { sleep, waits } = recordingSleep();
  const opts = { fetchImpl, sleep, family: `test:${Math.random()}`, minIntervalMs: 60_000 };
  await klaviyoGet('/api/flows', KEY, opts);
  await klaviyoGet('/api/flows', KEY, opts);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 55_000);
});
