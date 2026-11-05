// Unit tests for the duplicate scan's result cache (src/lib/duplicateScanCache.ts, #1434).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_SCAN_MAX_AGE_MS, makeScanCache, scanFingerprint } from '../../src/lib/duplicateScanCache.ts';

const at = new Date('2026-11-05T10:00:00Z');
const g = (isActive, count, latest = at) => ({ isActive, count, latestUpdatedAt: latest });

test('the fingerprint moves with the row count, the latest update and the cap', () => {
  const base = scanFingerprint([g(true, 5000)], 200);
  assert.notEqual(scanFingerprint([g(true, 4999)], 200), base, 'a merge removes a row');
  assert.notEqual(scanFingerprint([g(true, 5000, new Date(at.getTime() + 1))], 200), base, 'an edit bumps updatedAt');
  assert.notEqual(scanFingerprint([g(true, 5000)], 50), base, 'a different cap is a different answer');
  assert.equal(scanFingerprint([], 200), 'a0@0:i0@0:c200');
});

test('archiving moves the fingerprint even if no updatedAt moved', () => {
  // 5 000 active → 4 999 active + 1 archived, with the same latest timestamps.
  const before = scanFingerprint([g(true, 5000)], 200);
  const after = scanFingerprint([g(true, 4999), g(false, 1)], 200);
  assert.notEqual(after, before);
  // The group order the database returns does not matter.
  assert.equal(scanFingerprint([g(false, 1), g(true, 4999)], 200), after);
});

test('a hit needs the same org, the same fingerprint and a young entry', () => {
  const cache = makeScanCache();
  cache.set('org-a', 'fp1', ['pairs'], 1_000);
  assert.deepEqual(cache.get('org-a', 'fp1', 1_500), ['pairs']);
  assert.equal(cache.get('org-a', 'fp2', 1_500), null, 'the rows changed');
  assert.equal(cache.get('org-b', 'fp1', 1_500), null, 'never another org');
  assert.equal(cache.get('org-a', 'fp1', 1_000 + DUPLICATE_SCAN_MAX_AGE_MS), null, 'too old, even if unchanged');
});

test('it stays bounded', () => {
  const cache = makeScanCache();
  for (let i = 0; i < 200; i++) cache.set(`org-${i}`, 'fp', i, 0);
  assert.equal(cache.get('org-0', 'fp', 1), null, 'the oldest entries were evicted');
  assert.equal(cache.get('org-199', 'fp', 1), 199);
});
