// Per-API-key period quota and RateLimit headers (#2010): UTC periods, the
// quota decision, the binding limit the headers advertise, admin input.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { periodBounds, quotaDecision, bindingLimit, rateLimitHeaders, parseQuotaInput, MAX_QUOTA_LIMIT } = await import('../../src/lib/apiKeyQuotaRules.ts');

test('periods are UTC calendar days and months, half-open', () => {
  const at = new Date('2026-12-31T23:30:00.000Z');
  assert.deepEqual(periodBounds('day', at), { start: new Date('2026-12-31T00:00:00.000Z'), end: new Date('2027-01-01T00:00:00.000Z') });
  assert.deepEqual(periodBounds('month', at), { start: new Date('2026-12-01T00:00:00.000Z'), end: new Date('2027-01-01T00:00:00.000Z') });
});

test('a key past its allowance is refused, a key inside it never is, a key without one never is', () => {
  assert.deepEqual(quotaDecision(0, 2), { ok: true, remainingAfter: 1 });
  assert.deepEqual(quotaDecision(1, 2), { ok: true, remainingAfter: 0 });
  assert.deepEqual(quotaDecision(2, 2), { ok: false, remainingAfter: 0 });
  assert.deepEqual(quotaDecision(1_000_000, null), { ok: true, remainingAfter: null });
});

test('the headers advertise the limit closest to exhaustion', () => {
  const minute = { limit: 120, remaining: 100, resetAt: 1_000_060_000 };
  const quota = { limit: 1000, remaining: 3, resetAt: 1_086_400_000 };
  assert.equal(bindingLimit([minute, quota]), quota);
  assert.equal(bindingLimit([minute, null]), minute);
  assert.equal(bindingLimit([undefined]), null);
  // Tie on remaining: the one that binds longer.
  assert.equal(bindingLimit([{ ...minute, remaining: 3 }, quota]), quota);
  assert.deepEqual(rateLimitHeaders(minute, 1_000_000_000), { 'RateLimit-Limit': '120', 'RateLimit-Remaining': '100', 'RateLimit-Reset': '60' });
  assert.equal(rateLimitHeaders({ limit: 5, remaining: -2, resetAt: 0 }, 10)['RateLimit-Remaining'], '0');
});

test('admin quota input: both or neither, a real period, a positive whole limit', () => {
  assert.deepEqual(parseQuotaInput(null, null), { quotaPeriod: null, quotaLimit: null });
  assert.deepEqual(parseQuotaInput('', ''), { quotaPeriod: null, quotaLimit: null });
  assert.deepEqual(parseQuotaInput('day', 500), { quotaPeriod: 'day', quotaLimit: 500 });
  assert.deepEqual(parseQuotaInput('month', '1000'), { quotaPeriod: 'month', quotaLimit: 1000 });
  for (const [p, l] of [['day', null], [null, 5], ['week', 5], ['day', 0], ['day', 1.5], ['day', MAX_QUOTA_LIMIT + 1]]) {
    assert.equal(parseQuotaInput(p, l), null, `${p}/${l}`);
  }
});
