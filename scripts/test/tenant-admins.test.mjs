// Unit tests for the per-org admin recipient rule (#2542).
// Run: node --test --experimental-strip-types scripts/test/tenant-admins.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveOrgId, groupByOrg, tenantAdminWhereFor } from '../../src/lib/tenantAdminsRule.ts';

const DEFAULT = 'org-default';

test('a non-default org matches its own admins and nothing else', () => {
  assert.deepEqual(tenantAdminWhereFor('org-mkt', DEFAULT), {
    AND: [{ role: 'ADMIN', isActive: true }, { orgId: 'org-mkt' }],
  });
});

test('the default org also owns NULL-org admins (the backfill rule)', () => {
  assert.deepEqual(tenantAdminWhereFor(DEFAULT, DEFAULT), {
    AND: [{ role: 'ADMIN', isActive: true }, { OR: [{ orgId: DEFAULT }, { orgId: null }] }],
  });
});

test('an unknown subject org is the default org, never "every org"', () => {
  // The bug being fixed: no org filter at all meant every tenant's admins.
  for (const org of [null, undefined, '']) {
    const where = tenantAdminWhereFor(org, DEFAULT);
    assert.equal(where.AND.length, 2, 'always carries an org conjunct');
    assert.deepEqual(where.AND[1], { OR: [{ orgId: DEFAULT }, { orgId: null }] });
  }
});

test('the role and active conjunct is always present', () => {
  assert.deepEqual(tenantAdminWhereFor('org-x', DEFAULT).AND[0], { role: 'ADMIN', isActive: true });
});

test('effectiveOrgId folds NULL into the default org', () => {
  assert.equal(effectiveOrgId(null, DEFAULT), DEFAULT);
  assert.equal(effectiveOrgId(undefined, DEFAULT), DEFAULT);
  assert.equal(effectiveOrgId('org-a', DEFAULT), 'org-a');
});

test('groupByOrg splits recipients per org, NULL with the default org', () => {
  const rows = [
    { id: 'a1', orgId: DEFAULT },
    { id: 'm1', orgId: 'org-mkt' },
    { id: 'a2', orgId: null },
    { id: 'm2', orgId: 'org-mkt' },
  ];
  const grouped = groupByOrg(rows, DEFAULT);
  assert.deepEqual([...grouped.keys()], [DEFAULT, 'org-mkt']);
  assert.deepEqual(grouped.get(DEFAULT).map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(grouped.get('org-mkt').map((r) => r.id), ['m1', 'm2']);
});

test('groupByOrg never puts one org\'s row in another org\'s bucket', () => {
  const rows = [{ id: 'x', orgId: 'org-b' }];
  const grouped = groupByOrg(rows, DEFAULT);
  assert.equal(grouped.has(DEFAULT), false);
  assert.deepEqual(grouped.get('org-b').map((r) => r.id), ['x']);
});

test('groupByOrg of nothing is empty', () => {
  assert.equal(groupByOrg([], DEFAULT).size, 0);
});
