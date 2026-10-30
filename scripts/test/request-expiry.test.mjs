// Unit tests for the mentorship-request expiry rule (#1775).
//
// Run: node --test --experimental-strip-types scripts/test/request-expiry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_TTL_DAYS,
  daysUntilExpiry,
  effectiveExpiry,
  expiryAction,
  isLivePending,
  requestExpiresAt,
} from '../../src/lib/requestExpiryRule.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-01T09:00:00Z');
const at = (d) => new Date(T0.getTime() + d * DAY);
const req = (over = {}) => ({ status: 'PENDING', createdAt: T0, expiresAt: requestExpiresAt(T0), nudgeSentAt: null, ...over });

test('a request created today expires 14 days out', () => {
  assert.equal(requestExpiresAt(T0).getTime(), at(REQUEST_TTL_DAYS).getTime());
});

test('nothing before day 7, one nudge from day 7, never a second', () => {
  assert.equal(expiryAction(req(), at(6.9)), null);
  assert.equal(expiryAction(req(), at(7)), 'nudge');
  assert.equal(expiryAction(req({ nudgeSentAt: at(7) }), at(10)), null, 'exactly one nudge');
});

test('on expiry the request expires — expiry wins over a nudge that is also due', () => {
  assert.equal(expiryAction(req({ nudgeSentAt: at(7) }), at(14)), 'expire');
  assert.equal(expiryAction(req(), at(20)), 'expire', 'first seen on day 20: expired, not nudged');
});

test('decided, cancelled or expired requests are left alone', () => {
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']) {
    assert.equal(expiryAction(req({ status }), at(30)), null, status);
    assert.equal(isLivePending(req({ status }), at(1)), false, status);
  }
});

test('a request from before the column reads as createdAt + 14 days', () => {
  const legacy = req({ expiresAt: null });
  assert.equal(effectiveExpiry(legacy).getTime(), at(14).getTime());
  assert.equal(isLivePending(legacy, at(13)), true);
  assert.equal(isLivePending(legacy, at(14)), false, 'past its expiry it no longer blocks the mentee');
});

test('the countdown is whole days, never negative', () => {
  assert.equal(daysUntilExpiry(req(), at(0)), 14);
  assert.equal(daysUntilExpiry(req(), at(13.5)), 1);
  assert.equal(daysUntilExpiry(req(), at(20)), 0);
});
