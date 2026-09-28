// Unit tests for the caller-IP rule behind every IP-keyed rate limit (#858, #2470).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// `src/lib/clientIp.ts` decides which counter a request spends, so a header a
// client can write and the rule still believes is a free bucket per request.
// Two ways that has happened, both pinned here:
//   #858  the LEFTMOST X-Forwarded-For entry was read — the client-written one;
//   #2470 X-Real-IP was read even at TRUSTED_PROXY_COUNT=0, "no proxy, trust
//         nothing", where a client writes it as freely as the other header.
// The e2e half (a rotating leftmost entry against the running app, at the
// production setting) is `e2e/rate-limit.spec.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIp,
  clientIpFrom,
  headerSource,
  parseTrustedProxyCount,
} from '../../src/lib/clientIp.ts';

const req = (headers) => headerSource(headers);

test('TRUSTED_PROXY_COUNT=0 reads NEITHER proxy header (#2470)', () => {
  // The regression: with no proxy in front, X-Real-IP is exactly as
  // client-written as X-Forwarded-For. Rotating it bought a fresh bucket.
  for (const headers of [
    { 'X-Real-IP': '10.0.0.7' },
    { 'X-Forwarded-For': '10.0.0.7' },
    { 'X-Forwarded-For': '10.0.0.7, 10.0.0.8', 'X-Real-IP': '10.0.0.9' },
    { 'X-Forwarded-For': 'not-an-ip', 'X-Real-IP': '10.0.0.9' },
  ]) {
    assert.equal(clientIpFrom(req(headers), 0), 'unknown', JSON.stringify(headers));
  }
});

test('TRUSTED_PROXY_COUNT=0: rotating either header lands every caller on ONE key', () => {
  const keys = new Set();
  for (let i = 1; i <= 12; i++) {
    keys.add(clientIpFrom(req({ 'X-Real-IP': `9.9.9.${i}` }), 0));
    keys.add(clientIpFrom(req({ 'X-Forwarded-For': `9.9.9.${i}` }), 0));
  }
  assert.deepEqual([...keys], ['unknown']);
});

test('one hop: the entry the proxy appended wins, the client-written ones never do (#858)', () => {
  assert.equal(clientIpFrom(req({ 'X-Forwarded-For': '203.0.113.9' }), 1), '203.0.113.9');
  assert.equal(
    clientIpFrom(req({ 'X-Forwarded-For': '9.9.9.1, 9.9.9.2, 203.0.113.9' }), 1),
    '203.0.113.9',
  );
  // Rotating the leftmost entry is the #858 attack: the key must not move.
  const keys = new Set();
  for (let i = 1; i <= 12; i++) {
    keys.add(clientIpFrom(req({ 'X-Forwarded-For': `9.9.9.${i}, 203.0.113.9` }), 1));
  }
  assert.deepEqual([...keys], ['203.0.113.9']);
});

test('two hops: counts back two entries; a short list falls back to the rightmost', () => {
  assert.equal(
    clientIpFrom(req({ 'X-Forwarded-For': '9.9.9.1, 198.51.100.4, 203.0.113.9' }), 2),
    '198.51.100.4',
  );
  assert.equal(clientIpFrom(req({ 'X-Forwarded-For': '203.0.113.9' }), 2), '203.0.113.9');
});

test('behind a proxy, X-Real-IP is the fallback when there is no usable forwarded list', () => {
  assert.equal(clientIpFrom(req({ 'X-Real-IP': '203.0.113.9' }), 1), '203.0.113.9');
  assert.equal(
    clientIpFrom(req({ 'X-Forwarded-For': 'garbage', 'X-Real-IP': '203.0.113.9' }), 1),
    '203.0.113.9',
  );
  // A usable forwarded list answers first; X-Real-IP never overrides it.
  assert.equal(
    clientIpFrom(req({ 'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '10.0.0.1' }), 1),
    '203.0.113.9',
  );
  assert.equal(clientIpFrom(req({}), 1), 'unknown');
});

test('nothing but an address shape reaches the key', () => {
  for (const bad of ['', 'evil', '999.1.1.1', '1.2.3', '10.0.0.1\nx', 'a:b:g::1', '<script>']) {
    assert.equal(clientIpFrom(req({ 'X-Forwarded-For': bad }), 1), 'unknown', JSON.stringify(bad));
    assert.equal(clientIpFrom(req({ 'X-Real-IP': bad }), 1), 'unknown', JSON.stringify(bad));
  }
  assert.equal(clientIpFrom(req({ 'X-Forwarded-For': '[2001:DB8::1]' }), 1), '2001:db8::1');
});

test('parseTrustedProxyCount: unset means one hop; anything unreadable fails closed to 0', () => {
  assert.equal(parseTrustedProxyCount(undefined), 1);
  assert.equal(parseTrustedProxyCount(''), 1);
  assert.equal(parseTrustedProxyCount('0'), 0);
  assert.equal(parseTrustedProxyCount('2'), 2);
  assert.equal(parseTrustedProxyCount('-3'), 0);
  assert.equal(parseTrustedProxyCount('abc'), 0);
});

test('clientIp() applies the hop count read from the environment at load', () => {
  const hops = parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT);
  for (const headers of [{ 'X-Real-IP': '10.0.0.7' }, { 'X-Forwarded-For': '9.9.9.1, 203.0.113.9' }]) {
    assert.equal(clientIp(req(headers)), clientIpFrom(req(headers), hops));
  }
});

test('headerSource: header names are case-insensitive, missing ones read as null', () => {
  const src = headerSource({ 'X-Real-IP': '10.0.0.7', other: undefined });
  assert.equal(src.headers.get('x-real-ip'), '10.0.0.7');
  assert.equal(src.headers.get('X-REAL-IP'), '10.0.0.7');
  assert.equal(src.headers.get('x-forwarded-for'), null);
  assert.equal(headerSource().headers.get('x-real-ip'), null);
});
