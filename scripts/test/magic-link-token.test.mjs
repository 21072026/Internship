// Unit tests for the magic-link token rules (#1959).
// Run: node --test --experimental-strip-types scripts/test/magic-link-token.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_LINK_TTL_MS,
  generateLoginLinkToken,
  hashLoginLinkToken,
  isLoginLinkLive,
} from '../../src/lib/magicLinkToken.ts';

test('the link lives fifteen minutes', () => {
  assert.equal(LOGIN_LINK_TTL_MS, 15 * 60 * 1000);
});

test('a token is 256 bits of hex and never repeats', () => {
  const a = generateLoginLinkToken();
  const b = generateLoginLinkToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('the stored value is the SHA-256 of the token, never the token', () => {
  const raw = generateLoginLinkToken();
  const hash = hashLoginLinkToken(raw);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, raw);
  // Deterministic: the provider recomputes it from the presented link.
  assert.equal(hashLoginLinkToken(raw), hash);
  // A known vector, so a change of algorithm is a red test, not a silent
  // lock-out of every link already in a mailbox.
  assert.equal(
    hashLoginLinkToken('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('liveness: unspent and unexpired, nothing else', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const fresh = { expiresAt: new Date(now.getTime() + 60_000), usedAt: null };
  assert.equal(isLoginLinkLive(fresh, now), true);
  // Spent — even a second ago.
  assert.equal(isLoginLinkLive({ ...fresh, usedAt: new Date(now.getTime() - 1000) }, now), false);
  // Expired — even by a millisecond; the boundary itself is expired.
  assert.equal(isLoginLinkLive({ ...fresh, expiresAt: new Date(now.getTime() - 1) }, now), false);
  assert.equal(isLoginLinkLive({ ...fresh, expiresAt: now }, now), false);
  // Spent AND expired is still just "no".
  assert.equal(isLoginLinkLive({ expiresAt: new Date(0), usedAt: new Date(0) }, now), false);
});
