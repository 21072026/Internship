// Unit tests for the NPS arithmetic (#1910).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { npsFromScores, npsBand, npsTrend, isoWeek } = await import('../../src/lib/nps.ts');

test('standard bands: 9-10 promoter, 7-8 passive, 0-6 detractor', () => {
  assert.equal(npsBand(10), 'promoter');
  assert.equal(npsBand(9), 'promoter');
  assert.equal(npsBand(8), 'passive');
  assert.equal(npsBand(7), 'passive');
  assert.equal(npsBand(6), 'detractor');
  assert.equal(npsBand(0), 'detractor');
  assert.equal(npsBand(11), null);
  assert.equal(npsBand(7.5), null);
  assert.equal(npsBand('9'), null);
});

test('the score is % promoters − % detractors, rounded once, with its n', () => {
  assert.deepEqual(npsFromScores([10, 9, 9, 8, 6, 3]), { suppressed: false, n: 6, promoters: 3, passives: 1, detractors: 2, score: 17 });
  assert.equal(npsFromScores([10, 10, 10, 10, 10]).score, 100);
  assert.equal(npsFromScores([0, 1, 2, 3, 4]).score, -100);
  // Non-answers are not counted, in the n or anywhere else.
  assert.equal(npsFromScores([10, 9, 8, 7, 6, null, 'x']).n, 5);
});

test('the floor boundary: floor − 1 is suppressed, the floor is shown; a survey may raise it', () => {
  assert.deepEqual(npsFromScores([9, 9, 9, 9]), { suppressed: true, n: 4 });
  assert.equal(npsFromScores([9, 9, 9, 9, 9]).suppressed, false);
  assert.equal(npsFromScores([9, 9, 9, 9, 9], 8).suppressed, true);
  // ...never lower it.
  assert.equal(npsFromScores([9, 9, 9], 2).suppressed, true);
});

test('the trend is per period, oldest first, each period floored on its own', () => {
  const t = npsTrend([
    ...[10, 10, 9, 9, 3].map((value) => ({ period: '2026-W40', value })),
    ...[9, 2].map((value) => ({ period: '2026-W39', value })),
  ]);
  assert.deepEqual(t.map((p) => p.period), ['2026-W39', '2026-W40']);
  // W39 has 2 answers: hidden — and W40 with it, since the overall score
  // minus W40 would give W39 back.
  assert.deepEqual(t.map((p) => p.nps), [null, null]);
  const t2 = npsTrend([
    ...[10, 10, 9, 9, 3].map((value) => ({ period: '2026-W40', value })),
    ...[9, 9, 9, 2, 2].map((value) => ({ period: '2026-W41', value })),
    ...[9, 2].map((value) => ({ period: '2026-W39', value })),
    ...[1, 1, 1].map((value) => ({ period: '2026-W38', value })),
  ]);
  // W38 + W39 = 5 hidden answers reach the floor together: the rest is shown.
  assert.deepEqual(t2.map((p) => p.nps?.score ?? null), [null, null, 60, 20]);
});

test('ISO weeks', () => {
  assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T12:00:00Z')), '2026-W53');
  assert.equal(isoWeek(new Date('2026-10-06T12:00:00Z')), '2026-W41');
});
