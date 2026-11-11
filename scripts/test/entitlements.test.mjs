// Unit tests for the paid-feature gate (#517/#1733): `entitled()` is the one
// question every gate asks, it fails CLOSED without an org, an unexpired
// OrgEntitlement grant unlocks a feature the plan lacks, and `hasFeature()`
// survives as a company shim that still honours a legacy CompanyEntitlement row.
//
// Prisma is the in-memory fake from ./fake-prisma.mjs (#1598), so the
// subscription read path (src/lib/subscription.ts) runs for real underneath.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakePrisma } from './fake-prisma.mjs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const db = installFakePrisma();
const { entitled, entitledFeatures, hasFeature, getCompanyFeatureSources, getCompanyFeatures, PREMIUM_FEATURES } =
  await import('../../src/lib/entitlements.ts');

const KEYS = PREMIUM_FEATURES.map((f) => f.key);

beforeEach(() => {
  db.reset();
  // No subscription row → the legacy plan enum answers; FREE unless a test says otherwise.
  db.handlers['organization.findUnique'] = () => ({ plan: 'FREE' });
});

// A feature the FREE plan does not include — computed, so the test does not
// hard-code the plan catalogue.
async function paidOnly() {
  const free = await entitledFeatures('org-free');
  const key = KEYS.find((k) => !free.has(k));
  assert.ok(key, 'expected at least one feature FREE does not include');
  db.reset();
  db.handlers['organization.findUnique'] = () => ({ plan: 'FREE' });
  return key;
}

test('no org → false and an empty set, without a single query (fail closed)', async () => {
  assert.equal(await entitled(null, KEYS[0]), false);
  assert.equal((await entitledFeatures(undefined)).size, 0);
  assert.equal(db.calls.length, 0);
});

test('a feature outside the plan is refused, and an unexpired grant unlocks it', async () => {
  const key = await paidOnly();
  assert.equal(await entitled('org-1', key), false);
  db.handlers['orgEntitlement.findMany'] = () => [{ feature: key }];
  assert.equal(await entitled('org-1', key), true);
  // The grant query is what filters expiry: it must ask for "no expiry OR still in the future".
  const now = new Date('2026-10-30T00:00:00Z');
  await entitled('org-1', key, now);
  const grantRead = db.calls.filter((c) => c.model === 'orgEntitlement').at(-1);
  assert.deepEqual(grantRead.args.where.OR, [{ expiresAt: null }, { expiresAt: { gt: now } }]);
});

test('hasFeature: no company id, or no company, is false — never a throw', async () => {
  assert.equal(await hasFeature(null, KEYS[0]), false);
  db.handlers['company.findUnique'] = () => null;
  assert.equal(await hasFeature('c-missing', KEYS[0]), false);
});

test('hasFeature: the org decides first; a legacy CompanyEntitlement row is the grandfathered fallback', async () => {
  const key = await paidOnly();
  db.handlers['company.findUnique'] = () => ({ orgId: 'org-1' });
  assert.equal(await hasFeature('c1', key), false);
  db.handlers['companyEntitlement.findUnique'] = () => ({ id: 'legacy' });
  assert.equal(await hasFeature('c1', key), true);
  assert.equal(await hasFeature('c1', key), true, 'a second legacy hit is still true (logged once only)');
  db.handlers['companyEntitlement.findUnique'] = () => null;
  db.handlers['orgEntitlement.findMany'] = () => [{ feature: key }];
  assert.equal(await hasFeature('c1', key), true);
});

test('the admin grid: per feature, where access comes from — plan/grant, legacy override, or both', async () => {
  const key = await paidOnly();
  db.handlers['company.findUnique'] = () => ({ orgId: 'org-1' });
  db.handlers['companyEntitlement.findMany'] = () => [{ feature: key }];
  const sources = await getCompanyFeatureSources('c1');
  assert.deepEqual(Object.keys(sources).sort(), [...KEYS].sort());
  assert.deepEqual(sources[key], { enabled: true, fromPlan: false, override: true });
  const resolved = await getCompanyFeatures('c1');
  for (const k of KEYS) assert.equal(resolved[k], sources[k].enabled);
});
