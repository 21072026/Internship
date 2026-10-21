// Unit tests for the permission rule (src/lib/authzRule.ts, #1569).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Every property below type-checks while wrong — a dropped `!` turns a deny
// into an allow — so the fail-closed edges are pinned one by one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { PERMISSIONS, TIER_PERMISSIONS, ADMIN_TIERS, adminTierFor, decide, grantCovers } = await import(
  '../../src/lib/authzRule.ts'
);

const actor = (over = {}) => ({
  id: 'u1',
  role: 'ADMIN',
  adminLevel: 'ORG_ADMIN',
  orgId: 'org-a',
  companyId: null,
  impersonatorId: null,
  ...over,
});
const reason = (d) => (d.allow ? 'allow' : d.reason);

test('an unknown permission is refused, for every tier', () => {
  for (const tier of ADMIN_TIERS) {
    assert.equal(reason(decide({ actor: actor({ adminLevel: tier }), permission: 'org.everything' })), 'unknown_permission');
  }
  assert.equal(reason(decide({ actor: actor(), permission: '' })), 'unknown_permission');
});

test('an actor without a tier is refused every tenant permission', () => {
  for (const p of PERMISSIONS.filter((x) => !x.startsWith('platform.'))) {
    assert.equal(reason(decide({ actor: actor({ role: 'MENTOR', adminLevel: null }), permission: p })), 'no_tier', p);
  }
});

test('adminTierFor: only an ADMIN has a tier; an empty column is ORG_ADMIN; junk is none', () => {
  assert.equal(adminTierFor('ADMIN', null), 'ORG_ADMIN');
  assert.equal(adminTierFor('ADMIN', undefined), 'ORG_ADMIN');
  assert.equal(adminTierFor('ADMIN', 'OBSERVER'), 'OBSERVER');
  assert.equal(adminTierFor('ADMIN', 'PROGRAM_ADMIN'), 'PROGRAM_ADMIN');
  assert.equal(adminTierFor('ADMIN', 'SUPER_ADMIN'), null, 'there is no platform tier in the column');
  for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', undefined, null]) {
    assert.equal(adminTierFor(role, 'ORG_ADMIN'), null, String(role));
  }
});

test('no tier holds a platform permission, and OBSERVER holds reads only', () => {
  for (const tier of ADMIN_TIERS) {
    for (const p of TIER_PERMISSIONS[tier]) assert.ok(!p.startsWith('platform.'), `${tier}: ${p}`);
  }
  for (const p of TIER_PERMISSIONS.OBSERVER) assert.ok(p.endsWith('.read'), p);
  for (const p of ['user.impersonate', 'user.erase', 'pipeline.transition', 'audit.export']) {
    assert.equal(reason(decide({ actor: actor({ adminLevel: 'OBSERVER' }), permission: p })), 'not_in_tier', p);
  }
  assert.equal(reason(decide({ actor: actor({ adminLevel: 'OBSERVER' }), permission: 'audit.read' })), 'allow');
});

test('the tiers nest: ORG_ADMIN ⊃ PROGRAM_ADMIN ⊃ OBSERVER', () => {
  for (const p of TIER_PERMISSIONS.OBSERVER) assert.ok(TIER_PERMISSIONS.PROGRAM_ADMIN.has(p), p);
  for (const p of TIER_PERMISSIONS.PROGRAM_ADMIN) assert.ok(TIER_PERMISSIONS.ORG_ADMIN.has(p), p);
  assert.ok(TIER_PERMISSIONS.ORG_ADMIN.size > TIER_PERMISSIONS.PROGRAM_ADMIN.size);
  assert.ok(!TIER_PERMISSIONS.PROGRAM_ADMIN.has('user.impersonate'));
  assert.ok(!TIER_PERMISSIONS.PROGRAM_ADMIN.has('org.settings.write'));
});

test('platform permissions: only with platform reach, never through impersonation, never via a tier', () => {
  const p = 'platform.org.write';
  assert.equal(reason(decide({ actor: actor(), permission: p })), 'platform_only');
  assert.equal(reason(decide({ actor: actor(), permission: p, platformReach: false })), 'platform_only');
  assert.equal(reason(decide({ actor: actor(), permission: p, platformReach: true })), 'allow');
  assert.equal(
    reason(decide({ actor: actor({ impersonatorId: 'admin-0' }), permission: p, platformReach: true })),
    'impersonating',
  );
  // platformReach is the only door: a tier-less account with reach is still the
  // super admin's own call (the reach is computed from the flag, not the tier).
  assert.equal(reason(decide({ actor: actor({ adminLevel: null }), permission: p, platformReach: true })), 'allow');
});

test('a cross-org subject is refused for every tenant permission, platform reach or not', () => {
  for (const p of TIER_PERMISSIONS.ORG_ADMIN) {
    const d = decide({ actor: actor(), permission: p, subject: { orgId: 'org-b' }, platformReach: true });
    assert.equal(reason(d), 'cross_tenant', p);
  }
  assert.equal(reason(decide({ actor: actor(), permission: 'user.write', subject: { orgId: 'org-a' } })), 'allow');
  assert.equal(reason(decide({ actor: actor({ orgId: null }), permission: 'user.write', subject: { orgId: 'org-a' } })), 'cross_tenant');
});

test('an impersonated session keeps reads only', () => {
  const imp = actor({ impersonatorId: 'admin-0' });
  assert.equal(reason(decide({ actor: imp, permission: 'user.read' })), 'allow');
  for (const p of ['user.write', 'user.impersonate', 'user.erase', 'org.settings.write']) {
    assert.equal(reason(decide({ actor: imp, permission: p })), 'impersonating', p);
  }
});

test('PROGRAM_ADMIN: zero grants deny everything; the subject must fall inside a grant', () => {
  const pa = actor({ adminLevel: 'PROGRAM_ADMIN' });
  for (const p of TIER_PERMISSIONS.PROGRAM_ADMIN) {
    assert.equal(reason(decide({ actor: pa, permission: p, subject: { cohortId: 'c1' }, grants: [] })), 'no_scope', p);
    assert.equal(reason(decide({ actor: pa, permission: p, subject: { cohortId: 'c1' } })), 'no_scope', p);
  }
  const grants = [{ orgId: 'org-a', cohortId: 'c1', companyId: null }];
  assert.equal(reason(decide({ actor: pa, permission: 'program.write', subject: { cohortId: 'c1' }, grants })), 'allow');
  assert.equal(reason(decide({ actor: pa, permission: 'program.write', subject: { cohortId: 'c2' }, grants })), 'outside_scope');
  assert.equal(reason(decide({ actor: pa, permission: 'program.write', grants })), 'unscoped_subject');
  assert.equal(reason(decide({ actor: pa, permission: 'program.write', subject: { orgId: 'org-a' }, grants })), 'unscoped_subject');
  // A grant of another org is not a grant here.
  const foreign = [{ orgId: 'org-b', cohortId: 'c1', companyId: null }];
  assert.equal(reason(decide({ actor: pa, permission: 'program.write', subject: { cohortId: 'c1' }, grants: foreign })), 'no_scope');
  // In scope or not, an org-level permission is not the tier's.
  assert.equal(reason(decide({ actor: pa, permission: 'org.settings.write', subject: { cohortId: 'c1' }, grants })), 'not_in_tier');
});

test('PROGRAM_ADMIN listing: through with a grant (the caller narrows), refused without one', () => {
  const pa = actor({ adminLevel: 'PROGRAM_ADMIN' });
  const grants = [{ orgId: 'org-a', cohortId: 'c1', companyId: null }];
  assert.equal(reason(decide({ actor: pa, permission: 'audit.read', grants, listing: true })), 'allow');
  assert.equal(reason(decide({ actor: pa, permission: 'audit.read', grants: [], listing: true })), 'no_scope');
  assert.equal(reason(decide({ actor: pa, permission: 'org.settings.write', grants, listing: true })), 'not_in_tier');
  // A named subject is still checked against the grants, listing or not.
  assert.equal(reason(decide({ actor: pa, permission: 'audit.read', subject: { cohortId: 'c9' }, grants, listing: true })), 'outside_scope');
});

test('grantCovers: a grant naming nothing covers nothing; naming both narrows to both', () => {
  assert.equal(grantCovers({ orgId: 'o', cohortId: null, companyId: null }, { cohortId: 'c1' }), false);
  assert.equal(grantCovers({ orgId: 'o', cohortId: null, companyId: null }, {}), false);
  const both = { orgId: 'o', cohortId: 'c1', companyId: 'k1' };
  assert.equal(grantCovers(both, { cohortId: 'c1', companyId: 'k1' }), true);
  assert.equal(grantCovers(both, { cohortId: 'c1' }), false);
  assert.equal(grantCovers(both, { companyId: 'k1' }), false);
  assert.equal(grantCovers({ orgId: 'o', cohortId: null, companyId: 'k1' }, { companyId: 'k1', cohortId: 'any' }), true);
});

test('authz.ts stays server-only and the vertical gate keeps its own name', () => {
  const src = readFileSync(new URL('../../src/lib/authz.ts', import.meta.url), 'utf8');
  assert.match(src, /^import 'server-only';$/m);
  assert.doesNotMatch(src, /export (async )?function requireCapability\b/, 'requireCapability is the vertical gate');
  const gate = readFileSync(new URL('../../src/lib/capabilityGate.ts', import.meta.url), 'utf8');
  assert.match(gate, /export async function requireCapability\(/);
});
