// Unit tests for the tenant-pass rule of background sweeps (#1561).
//
// Run: node --test --experimental-strip-types scripts/test/for-each-tenant.test.mjs
//
// What is pinned: with isolation off a sweep makes ONE unscoped pass (today's
// recipient set, byte for byte — N middleware-reliant passes would each read
// every tenant's rows); with it on, one pass per org, each id once, in a stable
// order; and an empty organization table still yields one pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passFailure, tenantPasses } from '../../src/lib/jobs/forEachTenantRule.ts';

test('isolation off: one unscoped pass, whatever the orgs', () => {
  assert.deepEqual(tenantPasses({ enforced: false, orgIds: ['b', 'a'] }), [null]);
  assert.deepEqual(tenantPasses({ enforced: false, orgIds: [] }), [null]);
});

test('isolation on: one pass per org, deduplicated and sorted', () => {
  assert.deepEqual(tenantPasses({ enforced: true, orgIds: ['b', 'a', 'b'] }), ['a', 'b']);
  assert.deepEqual(tenantPasses({ enforced: true, orgIds: ['', 'a'] }), ['a']);
});

test('no organizations: still one unscoped pass', () => {
  assert.deepEqual(tenantPasses({ enforced: true, orgIds: [] }), [null]);
  assert.deepEqual(tenantPasses({ enforced: false, orgIds: [], perOrgWhenUnenforced: true }), [null]);
});

test('perOrgWhenUnenforced: per-org passes with the flag off', () => {
  assert.deepEqual(tenantPasses({ enforced: false, orgIds: ['z', 'y'], perOrgWhenUnenforced: true }), ['y', 'z']);
});

test('passFailure: class and message, bounded, never a stack', () => {
  const e = new TypeError('boom');
  assert.equal(passFailure(e), 'TypeError: boom');
  assert.ok(!passFailure(e).includes('\n    at '));
  assert.equal(passFailure('x'.repeat(900)).length, 500);
  assert.equal(passFailure(42), '42');
});
