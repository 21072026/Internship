// "Unassigned" candidates (#1440) — the pure half. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { UNASSIGNED_FILTER, isUnassignedFilter, unassignedMenteeWhere, candidateSort } = await import('../../src/lib/unassignedCandidates.ts');

test('the filter value is reserved lower-case, never a stage key', () => {
  assert.equal(UNASSIGNED_FILTER, 'unassigned');
  assert.equal(isUnassignedFilter('unassigned'), true);
  assert.equal(isUnassignedFilter('APPLICATION_100'), false);
  assert.equal(isUnassignedFilter(''), false);
  assert.equal(isUnassignedFilter(null), false);
  assert.notEqual(UNASSIGNED_FILTER, UNASSIGNED_FILTER.toUpperCase());
});

test('unassigned means no ACTIVE relation — a finished one does not count', () => {
  assert.deepEqual(unassignedMenteeWhere(), { menteeRelations: { none: { status: 'ACTIVE' } } });
});

test('the unassigned queue reads oldest first; everything else newest first; ?sort= wins', () => {
  assert.equal(candidateSort(null, 'unassigned'), 'oldest');
  assert.equal(candidateSort(null, 'APPLICATION_100'), 'newest');
  assert.equal(candidateSort(null, null), 'newest');
  assert.equal(candidateSort('newest', 'unassigned'), 'newest');
  assert.equal(candidateSort('oldest', null), 'oldest');
  assert.equal(candidateSort('bogus', 'unassigned'), 'oldest');
});
