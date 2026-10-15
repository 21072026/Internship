import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessages,
  chunk,
  classifyReceipts,
  classifyTickets,
  expoHeaders,
  isExpoPushToken,
  readReceipts,
  sendBatches,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  RECEIPT_BATCH,
  SEND_BATCH,
} from '../../src/lib/expoPushRules.ts';

// Native push through the Expo push service (#2775, docs/mobile-push.md): the
// batching, the ticket/receipt split that decides which rows are deleted and
// which are counted, and the never-throw contract — with `fetch` mocked, so no
// test talks to exp.host.

const targets = (n, host = 'interncrm.com') =>
  Array.from({ length: n }, (_, i) => ({ id: `row${i}`, token: `ExponentPushToken[tok${String(i).padStart(6, '0')}]`, host }));

const payload = { title: 'Ada', body: 'hi', url: '/messages/c/abc', tag: 'thread:/messages/c/abc' };

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, JSON.parse(init.body), calls.length);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, ok = true) => ({ ok, json: async () => body });

test('isExpoPushToken: both prefixes, a bounded safe alphabet, nothing else', () => {
  assert.ok(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'));
  assert.ok(isExpoPushToken('ExpoPushToken[abcDEF_123-xyz]'));
  for (const bad of [
    '',
    'ExponentPushToken[]',
    'ExponentPushToken[short]',
    'ExponentPushToken[has space here]',
    'ExponentPushToken[abc]def]',
    'https://fcm.googleapis.com/fcm/send/abc',
    `ExponentPushToken[${'a'.repeat(161)}]`,
    null,
    42,
  ]) {
    assert.equal(isExpoPushToken(bad), false, String(bad));
  }
});

test('buildMessages: data carries the relative url and the ROW host; channel and collapse key set', () => {
  const [m] = buildMessages([{ id: 'r', token: 'ExponentPushToken[aaaaaaaa]', host: 'marketing.example.test' }], payload);
  assert.deepEqual(m.data, { url: '/messages/c/abc', host: 'marketing.example.test' });
  assert.equal(m.to, 'ExponentPushToken[aaaaaaaa]');
  assert.equal(m.channelId, 'messages');
  assert.equal(m.priority, 'high');
  assert.equal(m.tag, payload.tag);
  assert.equal(m.collapseId, payload.tag);
  const [bare] = buildMessages([{ id: 'r', token: 'ExponentPushToken[aaaaaaaa]', host: 'h' }], { title: 't', body: 'b' });
  assert.deepEqual(bare.data, { host: 'h' });
  assert.equal('tag' in bare, false);
});

test('chunk: exact split, remainder last', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 100), []);
});

test('expoHeaders: Authorization only when an access token is configured', () => {
  assert.equal(expoHeaders(null).Authorization, undefined);
  assert.equal(expoHeaders('').Authorization, undefined);
  assert.equal(expoHeaders('sekret').Authorization, 'Bearer sekret');
});

test('classifyTickets: ok → delivered, DeviceNotRegistered → gone, any other error or a missing ticket → failed', () => {
  const batch = targets(4);
  const out = classifyTickets(batch, {
    data: [
      { status: 'ok', id: 't0' },
      { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } },
      // the fourth ticket is missing
    ],
  });
  assert.deepEqual(out.delivered, [{ rowId: 'row0', ticketId: 't0' }]);
  assert.deepEqual(out.gone, ['row1']);
  assert.deepEqual(out.failed, ['row2', 'row3']);
});

test('classifyTickets: a request-level error (no data) fails the whole batch, deletes nothing', () => {
  const out = classifyTickets(targets(3), { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] });
  assert.deepEqual(out.gone, []);
  assert.deepEqual(out.failed, ['row0', 'row1', 'row2']);
  assert.deepEqual(classifyTickets(targets(1), null).failed, ['row0']);
});

test('classifyReceipts: absence is not evidence; DeviceNotRegistered is', () => {
  const tickets = [
    { rowId: 'a', ticketId: '1' },
    { rowId: 'b', ticketId: '2' },
    { rowId: 'c', ticketId: '3' },
    { rowId: 'd', ticketId: '4' },
  ];
  const out = classifyReceipts(tickets, {
    data: {
      1: { status: 'ok' },
      2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      3: { status: 'error', details: { error: 'InvalidCredentials' } },
    },
  });
  assert.deepEqual(out, { ok: ['a'], gone: ['b'], failed: ['c'] });
  assert.deepEqual(classifyReceipts(tickets, { data: [] }), { ok: [], gone: [], failed: [] });
});

test('sendBatches: 250 tokens go out as 100 + 100 + 50 to the send endpoint', async () => {
  const fetch = mockFetch((url, body) => json({ data: body.map((_, i) => ({ status: 'ok', id: `${url.length}-${i}` })) }));
  const out = await sendBatches(targets(250), payload, { fetch, accessToken: 'tok' });
  assert.deepEqual(fetch.calls.map((c) => c.body.length), [SEND_BATCH, SEND_BATCH, 50]);
  assert.ok(fetch.calls.every((c) => c.url === EXPO_SEND_URL && c.init.method === 'POST'));
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(out.delivered.length, 250);
  assert.deepEqual(out.gone, []);
});

test('sendBatches: a thrown fetch or a 5xx fails only its own batch, and never throws', async () => {
  const fetch = mockFetch((_url, body, n) => {
    if (n === 1) throw new Error('ECONNRESET');
    if (n === 2) return json({ errors: [{ code: 'INTERNAL' }] }, false);
    return json({ data: body.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })) });
  });
  const out = await sendBatches(targets(201), payload, { fetch });
  assert.equal(out.failed.length, 200);
  assert.deepEqual(out.gone, ['row200']);
  assert.equal(fetch.calls[0].init.headers.Authorization, undefined);
});

test('readReceipts: ids batched by 1000, a failed read is skipped rather than blamed on the tokens', async () => {
  const tickets = Array.from({ length: 1500 }, (_, i) => ({ rowId: `r${i}`, ticketId: `t${i}` }));
  const fetch = mockFetch((url, body, n) => {
    assert.equal(url, EXPO_RECEIPTS_URL);
    if (n === 2) throw new Error('timeout');
    const data = {};
    for (const id of body.ids) data[id] = id === 't7' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' };
    return json({ data });
  });
  const out = await readReceipts(tickets, { fetch });
  assert.deepEqual(fetch.calls.map((c) => c.body.ids.length), [RECEIPT_BATCH, 500]);
  assert.deepEqual(out.gone, ['r7']);
  assert.equal(out.ok.length, 999);
  assert.deepEqual(out.failed, []);
});
