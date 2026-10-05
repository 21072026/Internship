// Unit test for the premiumAnalytics → ADVANCED_ANALYTICS backfill rule (#1740).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The script must grant exactly the orgs whose EFFECTIVE setting was 'true' by
// getSetting()'s rule — tenant row, then global row, then the default 'false' —
// or the deploy that retires the setting takes the tier away from somebody, or
// hands it to somebody who never had it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgsWithTier } from '../../prisma/backfill-premium-analytics-entitlement.mjs';

const ORGS = ['a', 'b', 'c'];

test('a tenant row decides for its own org', () => {
  assert.deepEqual(orgsWithTier(ORGS, [{ orgId: 'a', value: 'true' }, { orgId: 'b', value: 'false' }]), ['a']);
});

test('a global true reaches every org without its own row, and a tenant false still wins', () => {
  assert.deepEqual(orgsWithTier(ORGS, [{ orgId: null, value: 'true' }, { orgId: 'b', value: 'false' }]), ['a', 'c']);
});

test('no rows, or only false ones, grant nothing', () => {
  assert.deepEqual(orgsWithTier(ORGS, []), []);
  assert.deepEqual(orgsWithTier(ORGS, [{ orgId: null, value: 'false' }]), []);
});
