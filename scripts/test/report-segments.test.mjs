// Unit tests for segmenting registry reports (#1920, part 3) —
// src/lib/reports/segmentRule.ts: the floor runs AFTER the split, small
// segments become one named bucket (never dropped), every person is in
// exactly one segment, tenure is derived from a start date.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { planSegments, pickSegment, segmentFromParams, SEGMENT_BELOW, SEGMENT_NONE, SEGMENT_OTHER } = await import('../../src/lib/reports/segmentRule.ts');

const now = new Date('2026-10-20T12:00:00Z');
const total = (plan) => plan.segments.reduce((n, s) => n + s.size, 0);

test('a SELECT follows its options order; small segments fold into one bucket; totals reconcile', () => {
  const plan = planSegments({
    type: 'SELECT',
    options: ['Sales', 'Engineering', 'Legal', 'HR'],
    counts: [{ value: 'Engineering', count: 9 }, { value: 'Sales', count: 6 }, { value: 'Legal', count: 2 }, { value: 'HR', count: 1 }],
    noneCount: 3,
    minCohort: 5,
    now,
  });
  assert.deepEqual(plan.segments.map((s) => s.key), ['Sales', 'Engineering', SEGMENT_BELOW]);
  const below = plan.segments.at(-1);
  assert.deepEqual(below.values, ['Legal', 'HR']);
  assert.equal(below.includesNone, true, 'the small "no value" group goes into the bucket too');
  assert.equal(below.size, 6);
  assert.equal(plan.suppressedSegments, 3);
  assert.equal(total(plan), 9 + 6 + 2 + 1 + 3);
});

test('the bucket is emitted even when it is itself under the floor', () => {
  const plan = planSegments({ type: 'TEXT', counts: [{ value: 'Berlin', count: 2 }, { value: 'Ankara', count: 1 }], noneCount: 0, minCohort: 5, now });
  assert.deepEqual(plan.segments.map((s) => [s.key, s.size]), [[SEGMENT_BELOW, 3]]);
});

test('a large "no value" group is its own segment', () => {
  const plan = planSegments({ type: 'TEXT', counts: [{ value: 'Berlin', count: 7 }], noneCount: 12, minCohort: 5, now });
  assert.deepEqual(plan.segments.map((s) => s.key), ['Berlin', SEGMENT_NONE]);
  assert.equal(plan.suppressedSegments, 0);
});

test('beyond the display cap, large segments are combined as "other values", not as suppressed', () => {
  const counts = Array.from({ length: 5 }, (_, i) => ({ value: `v${i}`, count: 10 - i }));
  const plan = planSegments({ type: 'TEXT', counts, noneCount: 0, minCohort: 5, now, maxSegments: 3 });
  assert.deepEqual(plan.segments.map((s) => s.key), ['v0', 'v1', 'v2', SEGMENT_OTHER]);
  assert.deepEqual(plan.segments.at(-1).values, ['v3', 'v4']);
  assert.equal(plan.suppressedSegments, 0);
  assert.equal(total(plan), 10 + 9 + 8 + 7 + 6);
});

test('a DATE is segmented by derived tenure; an unreadable or future date counts as no value', () => {
  const plan = planSegments({
    type: 'DATE',
    counts: [
      { value: '2026-03-01', count: 3 },
      { value: '2026-05-01', count: 3 },
      { value: '2024-01-01', count: 5 },
      { value: '2019-01-01', count: 1 },
      { value: '2030-01-01', count: 2 },
    ],
    noneCount: 4,
    minCohort: 5,
    now,
  });
  assert.deepEqual(plan.segments.map((s) => s.key), ['lt1y', '1to3y', SEGMENT_NONE, SEGMENT_BELOW]);
  assert.deepEqual(plan.segments[0].values, ['2026-03-01', '2026-05-01']);
  assert.equal(plan.segments[2].size, 6, 'four without a value + two with a future start');
  assert.deepEqual(plan.segments[3].values, ['2019-01-01']);
});

test('filter mode: a segment under the floor is suppressed, an unknown one too', () => {
  const input = { type: 'TEXT', counts: [{ value: 'Berlin', count: 7 }, { value: 'Ankara', count: 2 }], noneCount: 0, minCohort: 5, now };
  assert.equal(pickSegment(input, 'Berlin').segment.size, 7);
  assert.deepEqual(pickSegment(input, 'Ankara'), { segment: null, suppressed: true });
  assert.deepEqual(pickSegment(input, 'Paris'), { segment: null, suppressed: true });
});

test('stored params are read by shape only', () => {
  assert.deepEqual(segmentFromParams({ segmentBy: 'department', segment: ' Sales ' }), { by: 'department', value: 'Sales' });
  assert.deepEqual(segmentFromParams({ segmentBy: 'department' }), { by: 'department', value: null });
  assert.equal(segmentFromParams({ segmentBy: 'Bad Key' }), null);
  assert.equal(segmentFromParams(null), null);
  assert.equal(segmentFromParams({}), null);
});
