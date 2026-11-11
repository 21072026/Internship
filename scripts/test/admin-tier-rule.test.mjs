// Admin tier assignment (#1579) — the pure guards. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { tierChangeRefusal, wouldRemoveLastOrgAdmin, grantRefusal } = await import('../../src/lib/adminTierRule.ts');
const { TIER_PERMISSIONS, decide } = await import('../../src/lib/authzRule.ts');

const change = (over = {}) => ({
  actorId: 'a',
  actorTier: 'ORG_ADMIN',
  targetId: 't',
  targetRole: 'ADMIN',
  targetLevel: 'ORG_ADMIN',
  next: 'OBSERVER',
  otherActiveOrgAdmins: 1,
  ...over,
});

test('admin.grant is an ORG_ADMIN power only — no narrower tier can assign tiers', () => {
  assert.equal(TIER_PERMISSIONS.ORG_ADMIN.has('admin.grant'), true);
  assert.equal(TIER_PERMISSIONS.PROGRAM_ADMIN.has('admin.grant'), false);
  assert.equal(TIER_PERMISSIONS.OBSERVER.has('admin.grant'), false);
  const actor = { id: 'x', role: 'ADMIN', adminLevel: 'ORG_ADMIN', orgId: 'o', companyId: null, impersonatorId: 'imp' };
  assert.deepEqual(decide({ actor, permission: 'admin.grant' }), { allow: false, reason: 'impersonating' });
});

test('no self-change, up or down', () => {
  assert.equal(tierChangeRefusal(change({ targetId: 'a' })), 'self_change');
  assert.equal(tierChangeRefusal(change({ targetId: 'a', next: 'ORG_ADMIN', targetLevel: 'OBSERVER' })), 'self_change');
});

test('never above one\'s own tier, never on someone above it', () => {
  assert.equal(tierChangeRefusal(change({ actorTier: 'PROGRAM_ADMIN', targetLevel: 'OBSERVER', next: 'ORG_ADMIN' })), 'above_own');
  assert.equal(tierChangeRefusal(change({ actorTier: 'PROGRAM_ADMIN', targetLevel: 'ORG_ADMIN', next: 'OBSERVER' })), 'target_above_own');
  assert.equal(tierChangeRefusal(change({ actorTier: null, targetLevel: 'OBSERVER', next: 'OBSERVER' })), 'above_own');
  assert.equal(tierChangeRefusal(change({ targetLevel: 'OBSERVER', next: 'ORG_ADMIN' })), null);
});

test('only an ADMIN has a tier; an empty column on an ADMIN is ORG_ADMIN', () => {
  assert.equal(tierChangeRefusal(change({ targetRole: 'MENTOR' })), 'not_admin');
  assert.equal(tierChangeRefusal(change({ targetLevel: null, otherActiveOrgAdmins: 0 })), 'last_org_admin');
});

test('the last active ORG_ADMIN stays', () => {
  assert.equal(tierChangeRefusal(change({ otherActiveOrgAdmins: 0 })), 'last_org_admin');
  assert.equal(tierChangeRefusal(change({ otherActiveOrgAdmins: 1 })), null);
  assert.equal(wouldRemoveLastOrgAdmin('ORG_ADMIN', null, 0), true, 'deactivation / deletion');
  assert.equal(wouldRemoveLastOrgAdmin('ORG_ADMIN', 'ORG_ADMIN', 0), false);
  assert.equal(wouldRemoveLastOrgAdmin('OBSERVER', null, 0), false);
});

test('scope grants: PROGRAM_ADMIN only, and they must name something', () => {
  assert.equal(grantRefusal('PROGRAM_ADMIN', { cohortId: 'c' }), null);
  assert.equal(grantRefusal('PROGRAM_ADMIN', {}), 'empty_grant');
  assert.equal(grantRefusal('OBSERVER', { cohortId: 'c' }), 'not_program_admin');
  assert.equal(grantRefusal('ORG_ADMIN', { companyId: 'c' }), 'not_program_admin');
});

test('the admin nav hides a write-only page from a tier that cannot open it (cosmetic; the 403 is the control)', async () => {
  const { ADMIN_NAV_LINKS, navAudienceAllows } = await import('../../src/lib/navLinks.ts');
  const automations = ADMIN_NAV_LINKS.find((l) => l.href === '/admin/automations');
  const users = ADMIN_NAV_LINKS.find((l) => l.href === '/admin/users');
  assert.equal(automations.permission, 'org.settings.write');
  assert.equal(navAudienceAllows(automations, { permissions: TIER_PERMISSIONS.OBSERVER }), false);
  assert.equal(navAudienceAllows(automations, { permissions: TIER_PERMISSIONS.ORG_ADMIN }), true);
  assert.equal(navAudienceAllows(users, { permissions: TIER_PERMISSIONS.OBSERVER }), true);
  assert.equal(navAudienceAllows(automations, {}), true, 'not judged without a tier');
});
