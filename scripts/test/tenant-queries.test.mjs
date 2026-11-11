// Unit tests for the tenant-query recognizer (#3588).
// Run: node --test scripts/test/tenant-queries.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sitesInSource, tenantModels } from '../check-tenant-queries.mjs';

const MODELS = ['Offer', 'User', 'Cohort'];
const sites = (src) => sitesInSource(src, 'x.ts', MODELS).map((s) => `${s.model}.${s.op}`);

test('a lookup by bare id is unscoped', () => {
  assert.deepEqual(sites(`await prisma.offer.findUnique({ where: { id } });`), ['Offer.findUnique']);
});

test('a list with no tenant is unscoped — the #3588 shape', () => {
  assert.deepEqual(sites(`const offers = await prisma.offer.findMany({ where: adminFilters(sp) });`), ['Offer.findMany']);
});

test('orgId or a scoping helper in the arguments is scoped', () => {
  assert.deepEqual(sites(`await prisma.offer.findMany({ where: { orgId, status } });`), []);
  assert.deepEqual(sites(`await prisma.offer.findFirst({ where: withinTenant({ id }, await tenantWhere(session)) });`), []);
});

test("the caller's own row is scoped", () => {
  assert.deepEqual(sites(`await prisma.user.findUnique({ where: { id: session.user.id } });`), []);
});

test('a one-row read followed by a tenant guard is scoped; a list is not', () => {
  const guarded = `const c = await prisma.cohort.findUnique({ where: { id } });\nif (!c || !(await inCallerTenant(c.orgId, orgId))) return notFound();`;
  assert.deepEqual(sites(guarded), []);
  const listThenGuard = `const all = await prisma.cohort.findMany({ where: {} });\nawait inCallerTenant(all[0].orgId, orgId);`;
  assert.deepEqual(sites(listThenGuard), ['Cohort.findMany']);
});

test('a where variable built with the tenant just above is scoped', () => {
  const src = `const where = withinTenant(filters, tenant);\nconst rows = await prisma.offer.findMany({ where });`;
  assert.deepEqual(sites(src), []);
});

test('a model outside TENANT_MODELS and comments are ignored', () => {
  assert.deepEqual(sites(`await prisma.statusChange.findMany({ where: {} });`), []);
  assert.deepEqual(sites(`// await prisma.offer.findMany({ where: {} });`), []);
});

test('assertSameOrg counts as a guard (it enforces with the flag off since #3588)', () => {
  const src = `const o = await prisma.offer.findUnique({ where: { id } });\nassertSameOrg(o.orgId, orgId, await defaultOrgId());`;
  assert.deepEqual(sites(src), []);
});

test('the model list is read from the TENANT_MODELS registry', () => {
  const models = tenantModels();
  assert.ok(models.includes('Offer') && models.includes('User') && models.includes('MentorshipRelation'));
});
