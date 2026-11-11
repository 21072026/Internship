// Unit tests for company → candidate message requests (#1840) —
// src/lib/outreachRule.ts: transitions, the revoke cooldown, the quota
// period and limit, and what a company may see of its own request.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { decisionTarget, canRevoke, requestRefusal, quotaPeriod, quotaLimit, companyView, isOutreachStatus, isOutreachSource, OUTREACH_SOURCES, REVOKE_COOLDOWN_DAYS } = await import('../../src/lib/outreachRule.ts');

const now = new Date('2026-10-21T10:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

test('only a PENDING request can be decided', () => {
  assert.equal(decisionTarget('PENDING', 'APPROVE'), 'APPROVED');
  assert.equal(decisionTarget('PENDING', 'DECLINE'), 'DECLINED');
  for (const s of ['APPROVED', 'DECLINED', 'REVOKED']) assert.equal(decisionTarget(s, 'APPROVE'), null);
});

test('only an APPROVED channel can be revoked', () => {
  assert.ok(canRevoke('APPROVED'));
  for (const s of ['PENDING', 'DECLINED', 'REVOKED']) assert.ok(!canRevoke(s));
});

test('a new request: refused while pending or open, blocked 90 days after a revoke, allowed after a decline', () => {
  assert.equal(requestRefusal(null, now), null);
  assert.equal(requestRefusal({ status: 'PENDING', revokedAt: null }, now), 'pending');
  assert.equal(requestRefusal({ status: 'APPROVED', revokedAt: null }, now), 'already_approved');
  assert.equal(requestRefusal({ status: 'DECLINED', revokedAt: null }, now), null);
  assert.equal(REVOKE_COOLDOWN_DAYS, 90);
  assert.equal(requestRefusal({ status: 'REVOKED', revokedAt: daysAgo(89) }, now), 'cooldown');
  assert.equal(requestRefusal({ status: 'REVOKED', revokedAt: daysAgo(91) }, now), null);
});

test('the quota counts a calendar month in UTC', () => {
  const { start, end } = quotaPeriod(new Date('2026-12-31T23:30:00Z'));
  assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('the limit: the company quota when set, else the setting, else 20', () => {
  assert.equal(quotaLimit(5, '20'), 5);
  assert.equal(quotaLimit(0, '20'), 0);
  assert.equal(quotaLimit(null, '12'), 12);
  assert.equal(quotaLimit(null, 'x'), 20);
  assert.equal(quotaLimit(undefined, undefined), 20);
});

test('a company sees status only — a revoked channel reads CLOSED, a pending one has no decision time', () => {
  const base = { id: 'o1', menteeId: 'm1', createdAt: now, decidedAt: now };
  // The whole of what a company reads — no name of a decider, no reason, no
  // contact detail of the candidate (#1394 adds only the request's door).
  assert.deepEqual(Object.keys(companyView({ ...base, status: 'DECLINED' })).sort(), ['createdAt', 'decidedAt', 'id', 'menteeId', 'source', 'status']);
  assert.equal(companyView({ ...base, status: 'REVOKED' }).status, 'CLOSED');
  assert.equal(companyView({ ...base, status: 'PENDING' }).decidedAt, null);
  assert.ok(isOutreachStatus('PENDING') && !isOutreachStatus('CLOSED'));
});

test('a request comes through one of two doors, an older row reading as a shortlist (#1394)', () => {
  assert.deepEqual([...OUTREACH_SOURCES], ['SHORTLIST', 'TALENT_POOL']);
  assert.equal(isOutreachSource('TALENT_POOL'), true);
  assert.equal(isOutreachSource('talent_pool'), false);
  const base = { id: 'o1', menteeId: 'm1', status: 'PENDING', createdAt: new Date(), decidedAt: null };
  assert.equal(companyView(base).source, 'SHORTLIST');
  assert.equal(companyView({ ...base, source: 'TALENT_POOL' }).source, 'TALENT_POOL');
  assert.equal(companyView({ ...base, source: 'ANYTHING' }).source, 'SHORTLIST');
});
