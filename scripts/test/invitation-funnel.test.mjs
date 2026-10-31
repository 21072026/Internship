// Unit tests for the invitation funnel rule (#1921, src/lib/invitationFunnelRule.ts).
//
// Run: node --test --experimental-strip-types scripts/test/invitation-funnel.test.mjs
//
// What a reviewer cannot keep in their head: the stages are cumulative (a stage
// never exceeds the one before it, even when the best-effort open stamp is
// missing), and a revoked invitation nobody used leaves the funnel instead of
// reading as an invitee who walked away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { funnelRate, invitationFunnel, reachedStage } from '../../src/lib/invitationFunnelRule.ts';

const base = { role: 'MENTEE', invitedById: 'a', openedAt: null, registeredAt: null, used: false, revokedAt: null, activated: false };
const at = '2026-10-01T00:00:00Z';

test('each invitation reaches exactly one stage, later stages implying earlier ones', () => {
  assert.equal(reachedStage(base), 'sent');
  assert.equal(reachedStage({ ...base, openedAt: at }), 'opened');
  assert.equal(reachedStage({ ...base, openedAt: at, registeredAt: at }), 'registered');
  // The open stamp is best-effort: a registration without one is still registered.
  assert.equal(reachedStage({ ...base, registeredAt: at }), 'registered');
  // Rows from before registeredAt existed only carry `used`.
  assert.equal(reachedStage({ ...base, used: true }), 'registered');
  assert.equal(reachedStage({ ...base, registeredAt: at, activated: true }), 'activated');
  // A sign-in without a registration is not an activation of THIS invitation.
  assert.equal(reachedStage({ ...base, activated: true }), 'sent');
});

test('a revoked invitation leaves the funnel unless someone already registered through it', () => {
  assert.equal(reachedStage({ ...base, openedAt: at, revokedAt: at }), null);
  assert.equal(reachedStage({ ...base, registeredAt: at, revokedAt: at }), 'registered');
});

test('the funnel is cumulative, per role and per inviter, busiest first', () => {
  const f = invitationFunnel([
    base,
    { ...base, openedAt: at },
    { ...base, registeredAt: at },
    { ...base, registeredAt: at, activated: true, invitedById: 'b' },
    { ...base, role: 'MENTOR', invitedById: 'b', openedAt: at, registeredAt: at, activated: true },
    { ...base, revokedAt: at },
  ]);
  assert.deepEqual(f.total, { sent: 5, opened: 4, registered: 3, activated: 2 });
  assert.equal(f.revoked, 1);
  assert.deepEqual(f.byRole, [
    { role: 'MENTEE', sent: 4, opened: 3, registered: 2, activated: 1 },
    { role: 'MENTOR', sent: 1, opened: 1, registered: 1, activated: 1 },
  ]);
  assert.deepEqual(f.byInviter, [
    { invitedById: 'a', sent: 3, opened: 2, registered: 1, activated: 0 },
    { invitedById: 'b', sent: 2, opened: 2, registered: 2, activated: 2 },
  ]);
  for (const row of [f.total, ...f.byRole, ...f.byInviter]) {
    assert.ok(row.sent >= row.opened && row.opened >= row.registered && row.registered >= row.activated);
  }
});

test('an empty funnel is zeros, and a rate over nothing is null, not 0%', () => {
  const f = invitationFunnel([]);
  assert.deepEqual(f.total, { sent: 0, opened: 0, registered: 0, activated: 0 });
  assert.deepEqual(f.byRole, []);
  assert.equal(funnelRate(0, 0), null);
  assert.equal(funnelRate(2, 3), 67);
});
