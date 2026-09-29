// Unit tests for the flag-independent one-row tenant boundary (#2542).
// Run: node --test --experimental-strip-types scripts/test/org-boundary.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameTenant } from '../../src/lib/orgScope.ts';

const DEFAULT = 'org-default';

test('a row of another org is not visible', () => {
  assert.equal(sameTenant('org-a', 'org-b', DEFAULT), false);
});

test('a row of the caller\'s own org is visible', () => {
  assert.equal(sameTenant('org-a', 'org-a', DEFAULT), true);
});

test('a NULL-org row is the default org\'s — visible there, nowhere else', () => {
  // The deploy backfill's rule, and tenantWhere()'s: a row not yet stamped
  // belongs to the default org.
  assert.equal(sameTenant(null, DEFAULT, DEFAULT), true);
  assert.equal(sameTenant(undefined, DEFAULT, DEFAULT), true);
  assert.equal(sameTenant(null, 'org-a', DEFAULT), false);
});

test('an org-less caller is the default org\'s, never a wildcard', () => {
  // A 12h JWT minted before the backfill stamped its user carries orgId null;
  // reading it as "unscoped" would fail open across every tenant.
  assert.equal(sameTenant('org-a', null, DEFAULT), false);
  assert.equal(sameTenant(DEFAULT, null, DEFAULT), true);
  assert.equal(sameTenant(null, null, DEFAULT), true);
  assert.equal(sameTenant('', '', DEFAULT), true);
});

test('the rule does not depend on MT_ENFORCE_ISOLATION', () => {
  const before = process.env.MT_ENFORCE_ISOLATION;
  try {
    for (const flag of [undefined, '', 'false', 'true']) {
      if (flag === undefined) delete process.env.MT_ENFORCE_ISOLATION;
      else process.env.MT_ENFORCE_ISOLATION = flag;
      assert.equal(sameTenant('org-a', 'org-b', DEFAULT), false, `flag=${flag}`);
      assert.equal(sameTenant('org-a', null, DEFAULT), false, `flag=${flag}`);
    }
  } finally {
    if (before === undefined) delete process.env.MT_ENFORCE_ISOLATION;
    else process.env.MT_ENFORCE_ISOLATION = before;
  }
});
