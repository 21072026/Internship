// Unit tests for the duplicate scan's result cache (src/lib/duplicateScanCache.ts, #1434).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_SCAN_MAX_AGE_MS, makeScanCache, scanFingerprint } from '../../src/lib/duplicateScanCache.ts';

test('the fingerprint moves with the row count, the latest update and the cap', () => {
  const at = new Date('2026-11-05T10:00:00Z');
  const base = scanFingerprint(5000, at, 200);
  assert.notEqual(scanFingerprint(4999, at, 200), base, 'a merge removes a row');
  assert.notEqual(scanFingerprint(5000, new Date(at.getTime() + 1), 200), base, 'an edit bumps updatedAt');
  assert.notEqual(scanFingerprint(5000, at, 50), base, 'a different cap is a different answer');
  assert.equal(scanFingerprint(0, null, 200), '0:0:200');
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
