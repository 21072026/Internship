// Unit tests for the audit trail viewer's pure parts (src/lib/auditViewRule.ts, #1583).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { auditRangeFrom, auditTargetsWhere, pairActivity, impersonationActivityFor, PAIR_WINDOW_MS } = await import(
  '../../src/lib/auditViewRule.ts'
);

test('auditRangeFrom: inclusive calendar days, malformed or reversed is invalid', () => {
  assert.equal(auditRangeFrom(null, null), null);
  assert.equal(auditRangeFrom('', '  '), null);
  assert.deepEqual(auditRangeFrom('2026-10-01', null), { gte: new Date('2026-10-01T00:00:00.000Z') });
  assert.deepEqual(auditRangeFrom(null, '2026-10-01'), { lt: new Date('2026-10-02T00:00:00.000Z') });
  assert.deepEqual(auditRangeFrom('2026-10-01', '2026-10-01'), {
    gte: new Date('2026-10-01T00:00:00.000Z'),
    lt: new Date('2026-10-02T00:00:00.000Z'),
  });
  for (const bad of ['2026-13-01', '2026-02-30', '01.10.2026', 'yesterday', '2026-10-1']) {
    assert.equal(auditRangeFrom(bad, null), 'invalid', bad);
  }
  assert.equal(auditRangeFrom('2026-10-02', '2026-10-01'), 'invalid');
});

test('auditTargetsWhere: no grant, or a grant naming nothing, reaches nobody', () => {
  assert.deepEqual(auditTargetsWhere([]), { id: '__none__' });
  assert.deepEqual(auditTargetsWhere([{ cohortId: null, companyId: null }]), { id: '__none__' });
});

test('auditTargetsWhere: relations inside the grant, and a company grant adds its own accounts', () => {
  const w = auditTargetsWhere([
    { cohortId: 'c1', companyId: null },
    { cohortId: 'c2', companyId: 'k2' },
    { cohortId: null, companyId: 'k3' },
  ]);
  const terms = [{ cohortId: 'c1' }, { cohortId: 'c2', companyId: 'k2' }, { companyId: 'k3' }];
  assert.deepEqual(w, {
    OR: [
      { menteeRelations: { some: { OR: terms } } },
      { mentorRelations: { some: { OR: terms } } },
      { role: 'COMPANY', companyId: { in: ['k3'] } },
    ],
  });
});

test('impersonationActivityFor: own keys only', () => {
  assert.equal(impersonationActivityFor('IMPERSONATE_START'), 'impersonate.start');
  assert.equal(impersonationActivityFor('IMPERSONATE_STOP'), 'impersonate.stop');
  assert.equal(impersonationActivityFor('USER_MERGE'), null);
  assert.equal(impersonationActivityFor('constructor'), null);
  assert.equal(impersonationActivityFor('toString'), null);
});

test('pairActivity: same action, actor and target, nearest within the window', () => {
  const at = new Date('2026-10-21T10:00:00.000Z');
  const row = { action: 'IMPERSONATE_START', actorId: 'a', targetId: 't', createdAt: at };
  const c = (id, over = {}) => ({
    id,
    action: 'impersonate.start',
    actorId: 'a',
    targetId: 't',
    ip: `ip-${id}`,
    userAgent: 'UA',
    createdAt: at,
    ...over,
  });
  assert.equal(pairActivity(row, []), null);
  assert.deepEqual(pairActivity(row, [c('x', { createdAt: new Date(at.getTime() + 2000) }), c('y', { createdAt: new Date(at.getTime() + 5) })]), {
    id: 'y',
    ip: 'ip-y',
    userAgent: 'UA',
  });
  assert.equal(pairActivity(row, [c('far', { createdAt: new Date(at.getTime() + PAIR_WINDOW_MS + 1) })]), null);
  assert.equal(pairActivity(row, [c('other', { targetId: 'u' })]), null);
  assert.equal(pairActivity(row, [c('other', { actorId: 'b' })]), null);
  assert.equal(pairActivity(row, [c('stop', { action: 'impersonate.stop' })]), null);
  assert.equal(pairActivity({ ...row, action: 'USER_MERGE' }, [c('x')]), null);
});
