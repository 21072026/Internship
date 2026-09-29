// Unit tests for the flag-independent org boundary (#2542).
// Run: node --test --experimental-strip-types scripts/test/org-boundary.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrgOrUnknown, orgScoped } from '../../src/lib/orgScope.ts';

test('a row of another org is not visible', () => {
  assert.equal(sameOrgOrUnknown('org-a', 'org-b'), false);
});

test('a row of the caller\'s own org is visible', () => {
  assert.equal(sameOrgOrUnknown('org-a', 'org-a'), true);
});

test('an unknown side is permissive — the single-tenant state must not break', () => {
  // A row that predates multi-tenancy, and an org-less session (every e2e-seeded
  // user): refusing here would take the live product down, not close a leak.
  assert.equal(sameOrgOrUnknown(null, 'org-a'), true);
  assert.equal(sameOrgOrUnknown('org-a', null), true);
  assert.equal(sameOrgOrUnknown(undefined, undefined), true);
});

test('the rule does not depend on MT_ENFORCE_ISOLATION', () => {
  const before = process.env.MT_ENFORCE_ISOLATION;
  try {
    for (const flag of [undefined, '', 'false', 'true']) {
      if (flag === undefined) delete process.env.MT_ENFORCE_ISOLATION;
      else process.env.MT_ENFORCE_ISOLATION = flag;
      assert.equal(sameOrgOrUnknown('org-a', 'org-b'), false, `flag=${flag}`);
    }
  } finally {
    if (before === undefined) delete process.env.MT_ENFORCE_ISOLATION;
    else process.env.MT_ENFORCE_ISOLATION = before;
  }
});

test('orgScoped — the list half of the same rule — is not flag-gated either', () => {
  delete process.env.MT_ENFORCE_ISOLATION;
  assert.deepEqual(orgScoped({ role: 'MENTEE' }, 'org-a'), { role: 'MENTEE', orgId: 'org-a' });
  assert.deepEqual(orgScoped({ role: 'MENTEE' }, null), { role: 'MENTEE' });
});
