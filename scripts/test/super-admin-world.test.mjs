// Unit tests for the per-world super admin rule (src/lib/superAdminWorld.ts).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The maintainer's rule: the INTERNSHIP and the MARKETING super admin are
// different accounts, each sees and manages only its own world's organizations,
// and the power is inert on the other world's host. Every property below
// type-checks perfectly while wrong — a flipped comparison is one token — so it
// is pinned here, with the operator script's plain-ESM mirror of the world rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { orgWorldWhere, orgInWorld, superAdminWorldFrom, superAdminReaches, creatableVertical } = await import(
  '../../src/lib/superAdminWorld.ts'
);
const { VERTICAL_KEYS } = await import('../../src/lib/verticals.ts');
const { worldUserWhere: scriptWorldUserWhere } = await import('../../prisma/set-super-admin.mjs');

const base = { flag: true, active: true, role: 'ADMIN', callerWorld: 'INTERNSHIP', requestWorld: 'INTERNSHIP' };

test('a super admin acts in its own world on its own world\'s host', () => {
  assert.equal(superAdminWorldFrom(base), 'INTERNSHIP');
  assert.equal(superAdminWorldFrom({ ...base, callerWorld: 'MARKETING', requestWorld: 'MARKETING' }), 'MARKETING');
});

test('the power is inert on the other world\'s host', () => {
  assert.equal(superAdminWorldFrom({ ...base, requestWorld: 'MARKETING' }), null);
  assert.equal(superAdminWorldFrom({ ...base, callerWorld: 'MARKETING', requestWorld: 'INTERNSHIP' }), null);
});

test('no request host, no flag, inactive, or not ADMIN: never a super admin', () => {
  assert.equal(superAdminWorldFrom({ ...base, requestWorld: null }), null);
  assert.equal(superAdminWorldFrom({ ...base, flag: false }), null);
  assert.equal(superAdminWorldFrom({ ...base, active: false }), null);
  for (const role of ['MENTOR', 'MENTEE', 'SOURCE', undefined, null]) {
    assert.equal(superAdminWorldFrom({ ...base, role }), null);
  }
});

test('a super admin reaches only organizations of its own world', () => {
  assert.equal(superAdminReaches('INTERNSHIP', 'INTERNSHIP'), true);
  assert.equal(superAdminReaches('INTERNSHIP', 'MARKETING'), false);
  assert.equal(superAdminReaches('MARKETING', 'MARKETING'), true);
  assert.equal(superAdminReaches('MARKETING', 'INTERNSHIP'), false);
  assert.equal(superAdminReaches(null, 'INTERNSHIP'), false);
  // An unregistered key reads as the default world — the same rule as userWorld.
  assert.equal(superAdminReaches('INTERNSHIP', 'NOT_A_VERTICAL'), true);
  assert.equal(superAdminReaches('MARKETING', 'NOT_A_VERTICAL'), false);
  assert.equal(orgInWorld(undefined, 'INTERNSHIP'), true);
});

test('create: vertical explicit and in the caller\'s world, else refused', () => {
  assert.equal(creatableVertical('INTERNSHIP', 'INTERNSHIP'), 'INTERNSHIP');
  assert.equal(creatableVertical('MARKETING', 'MARKETING'), 'MARKETING');
  assert.equal(creatableVertical('INTERNSHIP', 'MARKETING'), null);
  assert.equal(creatableVertical('MARKETING', 'INTERNSHIP'), null);
  for (const missing of [undefined, null, '', 'marketing', 'NOPE', 42]) {
    assert.equal(creatableVertical('INTERNSHIP', missing), null);
  }
});

test('orgWorldWhere: a non-default world is its vertical; the default is everything else', () => {
  assert.deepEqual(orgWorldWhere('MARKETING'), { vertical: 'MARKETING' });
  const others = VERTICAL_KEYS.filter((k) => k !== 'INTERNSHIP');
  assert.deepEqual(orgWorldWhere('INTERNSHIP'), { NOT: { vertical: { in: others } } });
});

test('the operator script\'s world rule mirrors the org rule', () => {
  for (const world of VERTICAL_KEYS) {
    const org = orgWorldWhere(world);
    const expected = 'NOT' in org ? { NOT: { org: { is: org.NOT } } } : { org: { is: org } };
    assert.deepEqual(scriptWorldUserWhere(world), expected, world);
  }
});
