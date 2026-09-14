// Unit tests for "who may clear somebody else's second factor" (#1543).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Clearing a TOTP secret turns a protected account into a password-only one, so
// every refusal below is the difference between a support tool and an
// account-takeover primitive. The two edges worth stating out loud:
//   - the actor's role is checked against a LIVE database read, so a demoted or
//     deactivated admin holding a still-valid 12h JWT is refused, and
//   - an ADMIN target is refused even when it is the caller themselves: the
//     account-owned route demands a valid authenticator code to switch the
//     factor off and this one demands none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTwoFactorReset } from '../../src/lib/twoFactorResetRule.ts';

const admin = (over = {}) => ({
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  isImpersonating: false,
  ...over,
});
const mentee = { id: 'user-9', role: 'MENTEE' };

test('an active admin may reset a non-admin user', () => {
  assert.deepEqual(evaluateTwoFactorReset(admin(), mentee), { ok: true });
  assert.deepEqual(evaluateTwoFactorReset(admin(), { id: 'user-3', role: 'MENTOR' }), { ok: true });
  assert.deepEqual(evaluateTwoFactorReset(admin(), { id: 'user-4', role: 'COMPANY' }), { ok: true });
});

test('no session, or a non-admin session, is 401', () => {
  for (const actor of [null, undefined, admin({ role: 'MENTOR' }), admin({ role: 'MENTEE' })]) {
    const d = evaluateTwoFactorReset(actor, mentee);
    assert.equal(d.ok, false);
    assert.equal(d.status, 401);
    assert.equal(d.code, 'not_admin');
  }
});

test('an admin whose account is no longer active is refused', () => {
  // The capability is read from the database precisely so this case exists: the
  // JWT still says ADMIN for up to 12h after the account was switched off.
  const d = evaluateTwoFactorReset(admin({ isActive: false }), mentee);
  assert.equal(d.ok, false);
  assert.equal(d.code, 'admin_capability_revoked');
  assert.equal(d.status, 403);
});

test('an impersonation session cannot reset anyone', () => {
  const d = evaluateTwoFactorReset(admin({ isImpersonating: true }), mentee);
  assert.equal(d.ok, false);
  assert.equal(d.code, 'impersonating');
  assert.equal(d.status, 400);
});

test('a peer admin target is refused', () => {
  const d = evaluateTwoFactorReset(admin(), { id: 'admin-2', role: 'ADMIN' });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'peer_admin');
  assert.equal(d.status, 400);
});

test('an admin cannot point the route at their own account either', () => {
  // /api/account/2fa's `disable` requires a valid authenticator code; this route
  // requires none, so self-service through here would be a code-free downgrade
  // available to anyone holding a stolen admin session.
  const d = evaluateTwoFactorReset(admin(), { id: 'admin-1', role: 'ADMIN' });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'self_target');
  assert.equal(d.status, 400);
});

test('an inactive admin is refused before the target is even considered', () => {
  // Order matters: the answer should name what is wrong with the CALLER first,
  // otherwise a revoked admin learns only that the target is uninteresting.
  const d = evaluateTwoFactorReset(
    admin({ isActive: false, isImpersonating: true }),
    { id: 'admin-2', role: 'ADMIN' },
  );
  assert.equal(d.code, 'admin_capability_revoked');
});
