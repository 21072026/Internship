// Unit tests for the mentor directory's scan-cap and filter arithmetic (#1820).
//
// Run: npm run test:mentor-directory  (node --test --experimental-strip-types)
//
// The bug these tests pin down: /api/mentors read the first 500 consented
// mentors, filtered them in JavaScript and reported the survivors as the
// TOTAL — so a mentor who held the searched skill but sorted 501st simply did
// not exist, and nothing said the answer was partial. The cap cannot fully go
// away until the skill taxonomy join table (#1815) lands, so what has to be
// exact meanwhile is the honesty of the flag: `partial` must be true when, and
// only when, rows were actually left unread.
//
// This is the only place that branch is exercised. An e2e run would have to
// seed 2001 consented mentors to reach it, so the arithmetic lives in a pure
// module and gets tested with a cap of 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScanCap,
  matchesTextFilters,
  pageSlice,
  toStringArray,
} from '../../src/lib/mentorDirectory.ts';

const CAP = 3;
// The route reads `take: CAP + 1`; these helpers mimic that read.
const readWith = (total) => Array.from({ length: Math.min(total, CAP + 1) }, (_, i) => `m${i}`);

test('a scan that fits under the cap is not partial', () => {
  const { rows, truncated } = applyScanCap(readWith(2), CAP);
  assert.equal(truncated, false);
  assert.deepEqual(rows, ['m0', 'm1']);
});

test('EXACTLY cap rows is a complete answer, not a partial one', () => {
  // The old `rows.length >= cap` test could not tell this case apart from a
  // truncated read, so a whole result set rendered the amber "this list may be
  // incomplete, narrow your filters" notice — advice that cannot help, because
  // there is nothing left out. The limit+1 probe is what makes it exact.
  const { rows, truncated } = applyScanCap(readWith(CAP), CAP);
  assert.equal(truncated, false);
  assert.equal(rows.length, CAP);
});

test('one row past the cap is partial, and the probe row is not shown', () => {
  const { rows, truncated } = applyScanCap(readWith(CAP + 1), CAP);
  assert.equal(truncated, true);
  assert.equal(rows.length, CAP, 'the probe row must never reach the response');
  assert.deepEqual(rows, ['m0', 'm1', 'm2']);
});

test('far more rows than the cap is still reported as partial', () => {
  const { truncated } = applyScanCap(readWith(9999), CAP);
  assert.equal(truncated, true);
});

test('an empty directory is complete, not partial', () => {
  const { rows, truncated } = applyScanCap([], CAP);
  assert.equal(truncated, false);
  assert.deepEqual(rows, []);
});

test('a JSON array column that is not an array degrades to no values', () => {
  assert.deepEqual(toStringArray(['React', 'Vue']), ['React', 'Vue']);
  assert.deepEqual(toStringArray(null), []);
  assert.deepEqual(toStringArray('React'), []);
  assert.deepEqual(toStringArray([1, 2]), ['1', '2']);
});

const mentor = (over = {}) => ({ skills: [], languages: [], interests: null, ...over });

test('the skill filter matches inside the skills array, case-insensitively', () => {
  const row = mentor({ skills: ['TypeScript', 'Kubernetes'] });
  assert.equal(matchesTextFilters(row, 'kubernetes', ''), true);
  assert.equal(matchesTextFilters(row, 'KUBER', ''), true);
  assert.equal(matchesTextFilters(row, 'rust', ''), false);
});

test('the skill filter also matches the free-text interests field', () => {
  // A mentor who wrote their expertise as prose instead of filling the skills
  // array is still findable — that is deliberate, not incidental.
  const row = mentor({ skills: [], interests: 'Mostly React and Next.js work' });
  assert.equal(matchesTextFilters(row, 'next.js', ''), true);
  assert.equal(matchesTextFilters(row, 'django', ''), false);
});

test('skill and language are ANDed, and an empty needle is not a filter', () => {
  const row = mentor({ skills: ['React'], languages: ['Turkish', 'English'] });
  assert.equal(matchesTextFilters(row, 'react', 'turkish'), true);
  assert.equal(matchesTextFilters(row, 'react', 'german'), false);
  assert.equal(matchesTextFilters(row, '', ''), true, 'no filter matches everybody');
  assert.equal(matchesTextFilters(mentor(), '', 'english'), false);
});

test('pages are 1-based, disjoint and cover the whole list', () => {
  const rows = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(pageSlice(rows, 1, 3), [0, 1, 2]);
  assert.deepEqual(pageSlice(rows, 2, 3), [3, 4, 5]);
  assert.deepEqual(pageSlice(rows, 3, 3), [6]);
  assert.deepEqual(pageSlice(rows, 4, 3), [], 'a page past the end is empty, not a wrap-around');
});
