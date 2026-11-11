// Unit tests for the PROGRAM_ADMIN read scope in src/lib/authzScope.ts (#1577).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The leak these pin down: every ADMIN builder answered `{}` ("the whole
// tenant"), so a PROGRAM_ADMIN granted ONE cohort read every relation of the
// org through GET /api/mentorship. The tier and the grants are read live by
// `scopeForRole`; the pure half (`roleScope`) is asserted here with them
// filled in, the way `scopeForRole` fills them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { roleScope, NO_MATCH } = await import('../../src/lib/authzScope.ts');

const admin = (adminLevel, grants = [], orgId = 'org-1') => ({ id: 'a-1', role: 'ADMIN', email: 'a@example.com', orgId, adminLevel, grants });

test('ORG_ADMIN — and an ADMIN with an empty tier column — reads the whole tenant', async () => {
  for (const level of ['ORG_ADMIN', null]) {
    for (const r of ['relation', 'project', 'company']) assert.deepEqual(await roleScope(admin(level), r), {});
  }
});

test('OBSERVER reads the whole tenant; its grants play no part', async () => {
  const grants = [{ orgId: 'org-1', cohortId: 'c-1', companyId: null }];
  for (const r of ['relation', 'project', 'company']) assert.deepEqual(await roleScope(admin('OBSERVER', grants), r), {});
});

test('a PROGRAM_ADMIN with no grant reads nothing, never everything', async () => {
  for (const r of ['relation', 'project', 'company']) assert.deepEqual(await roleScope(admin('PROGRAM_ADMIN'), r), { id: NO_MATCH });
});

test('a PROGRAM_ADMIN reads the relations of its granted cohorts and companies', async () => {
  const grants = [
    { orgId: 'org-1', cohortId: 'c-1', companyId: null },
    { orgId: 'org-1', cohortId: null, companyId: 'co-1' },
    { orgId: 'org-1', cohortId: 'c-2', companyId: 'co-2' },
  ];
  assert.deepEqual(await roleScope(admin('PROGRAM_ADMIN', grants), 'relation'), {
    OR: [{ cohortId: 'c-1' }, { companyId: 'co-1' }, { cohortId: 'c-2', companyId: 'co-2' }],
  });
  assert.deepEqual(await roleScope(admin('PROGRAM_ADMIN', grants), 'project'), {
    relations: { some: { OR: [{ cohortId: 'c-1' }, { companyId: 'co-1' }, { cohortId: 'c-2', companyId: 'co-2' }] } },
  });
  assert.deepEqual(await roleScope(admin('PROGRAM_ADMIN', grants), 'company'), {
    OR: [{ mentorships: { some: { cohortId: 'c-1' } } }, { id: 'co-1' }, { id: 'co-2' }],
  });
});

test('a grant of ANOTHER org is ignored — it can never widen a scope', async () => {
  const grants = [{ orgId: 'org-2', cohortId: 'c-9', companyId: null }];
  for (const r of ['relation', 'project', 'company']) assert.deepEqual(await roleScope(admin('PROGRAM_ADMIN', grants), r), { id: NO_MATCH });
});

test('an unknown tier value reads nothing', async () => {
  assert.deepEqual(await roleScope(admin('SUPER_ADMIN'), 'relation'), { id: NO_MATCH });
});
