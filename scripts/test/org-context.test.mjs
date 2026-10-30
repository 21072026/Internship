// Unit tests for the tenant context and its Prisma middleware (#543/#1568/#1546,
// docs/tenant-isolation.md): what `runWithOrg` binds, and what the middleware
// does to a query on a registered model once MT_ENFORCE_ISOLATION is on —
// scope every read/update/delete, fill `orgId` into creates, leave an
// explicit orgId and unregistered models alone. Plus the API-key guard that
// refuses a tenant-model query with no org bound.
//
// The middleware is installed through `prisma.$use`, which the in-memory fake
// from ./fake-prisma.mjs records (#1598), so each test calls it directly with a
// params object and a `next` that captures what Prisma would have run.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakePrisma } from './fake-prisma.mjs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const db = installFakePrisma();
// Read on every call, so setting it here switches enforcement on for the whole file.
process.env.MT_ENFORCE_ISOLATION = 'true';
const ctx = await import('../../src/lib/orgContext.ts');
const { currentOrgId, runWithOrg, withTenantScope, runAsApiKeyRequest, runWithApiKeyOrg, outsideApiKeyRequest, assertApiKeyRequestContext } =
  ctx;

// prisma.ts registered its query observer first; the tenant middleware is the
// one runWithOrg installs, on first use.
const before = db.middlewares.length;
runWithOrg('org-a', () => {});
const tenantMiddleware = db.middlewares[before];
assert.equal(db.middlewares.length, before + 1, 'runWithOrg installs the tenant middleware once');
runWithOrg('org-a', () => {});
assert.equal(db.middlewares.length, before + 1, 'and never a second copy');

// Run the middleware for one query inside `orgId`'s context; returns the params Prisma would see.
async function scoped(orgId, params) {
  let seen;
  await runWithOrg(orgId, () => tenantMiddleware(params, async (p) => (seen = p)));
  return seen;
}

test('the context: undefined outside, the bound org inside, null for "context but no org"', async () => {
  assert.equal(currentOrgId(), undefined);
  assert.equal(runWithOrg('org-a', () => currentOrgId()), 'org-a');
  assert.equal(runWithOrg(null, () => currentOrgId()), null);
  // An async callback keeps its context across awaits, and the promise is passed through.
  const got = await runWithOrg('org-b', async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentOrgId();
  });
  assert.equal(got, 'org-b');
  await assert.rejects(runWithOrg('org-b', async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(withTenantScope({ user: { orgId: 'org-s' } }, () => currentOrgId()), 'org-s');
  assert.equal(withTenantScope(null, () => currentOrgId()), null);
});

test('reads, updates and deletes on a registered model get the org merged into `where`', async () => {
  for (const action of ['findMany', 'findFirst', 'findUnique', 'count', 'groupBy', 'updateMany', 'update', 'deleteMany']) {
    const p = await scoped('org-a', { model: 'User', action, args: { where: { role: 'MENTOR' } } });
    assert.deepEqual(p.args.where, { role: 'MENTOR', orgId: 'org-a' }, action);
  }
  const bare = await scoped('org-a', { model: 'Company', action: 'findMany', args: undefined });
  assert.deepEqual(bare.args.where, { orgId: 'org-a' });
});

test('creates get the bound org filled in — unless the caller already passed one', async () => {
  const one = await scoped('org-a', { model: 'Project', action: 'create', args: { data: { name: 'x' } } });
  assert.equal(one.args.data.orgId, 'org-a');
  const explicit = await scoped('org-a', { model: 'Project', action: 'create', args: { data: { name: 'x', orgId: null } } });
  assert.equal(explicit.args.data.orgId, null, 'an explicit null is a decision, not a gap');
  const many = await scoped('org-a', {
    model: 'Project',
    action: 'createMany',
    args: { data: [{ name: 'a' }, { name: 'b', orgId: 'org-z' }] },
  });
  assert.deepEqual(many.args.data.map((r) => r.orgId), ['org-a', 'org-z']);
  const up = await scoped('org-a', { model: 'Project', action: 'upsert', args: { where: { id: 'p1' }, create: { name: 'c' }, update: {} } });
  assert.deepEqual(up.args.where, { id: 'p1', orgId: 'org-a' });
  assert.equal(up.args.create.orgId, 'org-a');
});

test('untouched: unregistered models, a context with no org, and enforcement switched off', async () => {
  const child = await scoped('org-a', { model: 'Message', action: 'findMany', args: { where: { relationId: 'r' } } });
  assert.deepEqual(child.args.where, { relationId: 'r' }, 'children are reached through a scoped parent');
  const noOrg = await scoped(null, { model: 'User', action: 'findMany', args: { where: {} } });
  assert.deepEqual(noOrg.args.where, {});
  process.env.MT_ENFORCE_ISOLATION = 'false';
  try {
    const off = await scoped('org-a', { model: 'User', action: 'findMany', args: { where: {} } });
    assert.deepEqual(off.args.where, {});
  } finally {
    process.env.MT_ENFORCE_ISOLATION = 'true';
  }
});

test('API-key requests: no org bound → a tenant-model query throws; bound → it runs', async () => {
  const n = db.middlewares.length;
  await runAsApiKeyRequest(async () => {});
  const guard = db.middlewares[n];
  assert.equal(typeof guard, 'function', 'runAsApiKeyRequest installs the guard (non-production)');
  const next = async (p) => p;
  await runAsApiKeyRequest(async () => {
    await assert.rejects(guard({ model: 'User', action: 'findMany', args: {} }, next), /no organisation bound/);
    assert.ok(await guard({ model: 'ApiKey', action: 'findFirst', args: {} }, next), 'the key lookup itself is allowed');
    await runWithApiKeyOrg('org-k', async () => {
      assert.equal(currentOrgId(), 'org-k');
      assert.ok(await guard({ model: 'User', action: 'findMany', args: {} }, next));
    });
    // outsideApiKeyRequest leaves the API-key context, so the guard has nothing to object to.
    await outsideApiKeyRequest(() => guard({ model: 'User', action: 'findMany', args: {} }, next));
  });
  assert.doesNotThrow(() => runAsApiKeyRequest(async () => assertApiKeyRequestContext('test')));
  assert.throws(() => assertApiKeyRequestContext('test'), /ran outside runAsApiKeyRequest/);
  assert.throws(() => runWithApiKeyOrg('org-k', () => {}), /ran outside runAsApiKeyRequest/);
});
