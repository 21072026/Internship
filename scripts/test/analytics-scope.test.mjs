// Unit tests for src/lib/analyticsScope.ts — the tenant/world fragments the
// analytics routes AND in by hand (leak audit WP3).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The leak these pin down: with MT_ENFORCE_ISOLATION off every analytics
// groupBy/count summed every organization, so a MARKETING admin's numbers
// included the INTERNSHIP product's rows. Interactions and meetings carry no
// `orgId`, so which PARENT decides their tenant is written once in the module
// under test; the benchmark's peer pool is narrowed to the caller's world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { interactionInTenant, meetingInTenant, orgInWorldWhere, benchmarkOrgKey } = await import(
  '../../src/lib/analyticsScope.ts'
);

const MARKETING = { orgId: 'org-m' };
const DEFAULT = { OR: [{ orgId: 'org-d' }, { orgId: null }] };

test('an interaction belongs to its relation\'s tenant', () => {
  assert.deepEqual(interactionInTenant(MARKETING), { relation: { is: { orgId: 'org-m' } } });
  // The default org's fragment is passed through whole, NULL rows included.
  assert.deepEqual(interactionInTenant(DEFAULT), { relation: { is: DEFAULT } });
});

test('a meeting belongs to its relation\'s OR its project\'s tenant — never neither', () => {
  assert.deepEqual(meetingInTenant(MARKETING), {
    OR: [{ relation: { is: { orgId: 'org-m' } } }, { project: { is: { orgId: 'org-m' } } }],
  });
  // No bare `{}` for a real tenant: that would count every org's meetings.
  assert.notDeepEqual(meetingInTenant(DEFAULT), {});
});

test('the no-session fragment stays `{}` (callers have already rejected it)', () => {
  assert.deepEqual(interactionInTenant({}), {});
  assert.deepEqual(meetingInTenant({}), {});
});

test('the MARKETING world is exactly the MARKETING orgs', () => {
  assert.deepEqual(orgInWorldWhere('MARKETING'), { org: { is: { vertical: 'MARKETING' } } });
});

test('the default world is every org NOT in another vertical — org-less rows included', () => {
  const w = orgInWorldWhere('INTERNSHIP');
  assert.ok(w.NOT, 'expressed as a NOT so a NULL-org relation (the default org\'s) stays in');
  assert.deepEqual(w.NOT.org.is.vertical.in.includes('MARKETING'), true);
  assert.equal(w.NOT.org.is.vertical.in.includes('INTERNSHIP'), false);
});

test('an unknown world reads as the default world, never as "everything"', () => {
  assert.deepEqual(orgInWorldWhere('NOPE'), orgInWorldWhere('INTERNSHIP'));
});

test('a NULL-org benchmark row folds into the default org, not an extra programme', () => {
  assert.equal(benchmarkOrgKey(null, 'org-d'), 'org-d');
  assert.equal(benchmarkOrgKey(undefined, 'org-d'), 'org-d');
  assert.equal(benchmarkOrgKey('org-m', 'org-d'), 'org-m');
});
