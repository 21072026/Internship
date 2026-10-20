// Unit tests for the cross-program benchmark's anonymity floors
// (src/lib/benchmarkPool.ts, #542 / #1575).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFigures, MIN_OTHER_PROGRAMS, MIN_RELATIONS } from '../../src/lib/benchmarkPool.ts';

const agg = (total, hired, dropped = 0) => ({ total, hired, dropped });
const programs = (entries) => new Map(entries);

test('the floors are what the route documents', () => {
  assert.equal(MIN_RELATIONS, 5);
  assert.equal(MIN_OTHER_PROGRAMS, 3);
});

test('one other qualifying program: no average, so its exact rate never leaves', () => {
  const f = benchmarkFigures(programs([['me', agg(10, 5)], ['other', agg(10, 9, 1)]]), 'me');
  assert.equal(f.poolSize, 1);
  assert.equal(f.avgConversion, null);
  assert.equal(f.avgDropRate, null);
  assert.equal(f.percentile, null);
  // The viewer still sees their own numbers.
  assert.deepEqual(f.you, { conversion: 50, dropRate: 0, total: 10, hired: 5 });
});

test('two other programs: still nothing — an average of two is one subtraction from either', () => {
  const f = benchmarkFigures(programs([['me', agg(10, 5)], ['a', agg(10, 9)], ['b', agg(10, 1)]]), 'me');
  assert.equal(f.poolSize, 2);
  assert.equal(f.avgConversion, null);
  assert.equal(f.percentile, null);
});

test('the viewer is never part of the pool it is compared against', () => {
  // Three others at 90/10/50 → average 50, whatever the viewer's own rate.
  const others = [['a', agg(10, 9)], ['b', agg(10, 1)], ['c', agg(10, 5)]];
  const low = benchmarkFigures(programs([['me', agg(10, 0)], ...others]), 'me');
  const high = benchmarkFigures(programs([['me', agg(10, 10)], ...others]), 'me');
  assert.equal(low.poolSize, 3);
  assert.equal(low.avgConversion, 50);
  assert.equal(high.avgConversion, 50);
  // Percentile: share of OTHER programs at or below the viewer's conversion.
  assert.equal(low.percentile, 0);
  assert.equal(high.percentile, 100);
});

test('programs under the relation floor never count towards the pool', () => {
  const f = benchmarkFigures(
    programs([['me', agg(10, 5)], ['a', agg(10, 9)], ['b', agg(10, 1)], ['tiny', agg(MIN_RELATIONS - 1, 4)]]),
    'me',
  );
  assert.equal(f.poolSize, 2);
  assert.equal(f.avgConversion, null);
});

test('a viewer with no relations of its own still gets no figure from a small pool', () => {
  const f = benchmarkFigures(programs([['a', agg(10, 9)]]), 'me');
  assert.equal(f.you, null);
  assert.equal(f.avgConversion, null);
});
