// Unit tests for the SOURCE outcome panel's arithmetic (#1914).
//
// Run: node --test --experimental-strip-types scripts/test/source-outcomes.test.mjs
// (also covered by `npm run test:unit`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referralRow, summarizeOutcomes, flooredRate, monthsBetween } from '../../src/lib/sourceOutcomesRule.ts';

const FINISHED = ['HIRED_660', 'EMPLOYED_700'];
const OFF = ['INTERNSHIP_DROPPED_460'];
const NOW = new Date('2026-10-30T12:00:00Z');
const d = (s) => new Date(`${s}T00:00:00Z`);

function referral(id, referredAt, relations = []) {
  return { id, referredAt: d(referredAt), relations };
}

test('placement is the FIRST arrival at a finished stage, across relations', () => {
  const row = referralRow(referral('a', '2026-01-01', [
    { startedAt: d('2026-01-05'), pipelineStatus: 'EMPLOYED_700', changes: [
      { toStatus: 'EMPLOYED_700', at: d('2026-04-01') },
      { toStatus: 'HIRED_660', at: d('2026-03-01') },
    ] },
  ]), FINISHED, NOW);
  assert.equal(row.placed, true);
  assert.equal(row.placedAt.toISOString(), d('2026-03-01').toISOString());
  assert.equal(row.stage, 'EMPLOYED_700');
});

test('a relation created straight onto a finished stage is placed at its start', () => {
  const row = referralRow(referral('b', '2026-02-01', [
    { startedAt: d('2026-02-10'), pipelineStatus: 'HIRED_660', changes: [] },
  ]), FINISHED, NOW);
  assert.equal(row.placedAt.toISOString(), d('2026-02-10').toISOString());
});

test('the current stage is the newest relation; nobody picked up = null', () => {
  const row = referralRow(referral('c', '2026-01-01', [
    { startedAt: d('2026-01-02'), pipelineStatus: 'INTERNSHIP_DROPPED_460', changes: [] },
    { startedAt: d('2026-05-02'), pipelineStatus: 'INTERVIEW_PENDING_250', changes: [] },
  ]), FINISHED, NOW);
  assert.equal(row.stage, 'INTERVIEW_PENDING_250');
  assert.equal(referralRow(referral('x', '2026-01-01'), FINISHED, NOW).stage, null);
});

test('the median time to placement leaves unplaced referrals OUT', () => {
  const rows = [
    referralRow(referral('p1', '2026-01-01', [{ startedAt: d('2026-01-01'), pipelineStatus: 'HIRED_660', changes: [{ toStatus: 'HIRED_660', at: d('2026-01-11') }] }]), FINISHED, NOW),
    referralRow(referral('p2', '2026-01-01', [{ startedAt: d('2026-01-01'), pipelineStatus: 'HIRED_660', changes: [{ toStatus: 'HIRED_660', at: d('2026-01-31') }] }]), FINISHED, NOW),
    // Long-waiting, not placed: counting it would drag the median either way.
    referralRow(referral('u1', '2025-11-01', [{ startedAt: d('2025-11-02'), pipelineStatus: 'INTERVIEW_PENDING_250', changes: [] }]), FINISHED, NOW),
    referralRow(referral('u2', '2026-10-29'), FINISHED, NOW),
  ];
  const s = summarizeOutcomes(rows, { offPath: OFF, minCohort: 5, from: d('2025-11-01'), to: NOW });
  assert.equal(s.timeToPlacement.medianDays, 20);
  assert.equal(s.timeToPlacement.placed, 2);
  assert.equal(s.timeToPlacement.considered, 4);
});

test('below the floor there is no conversion rate, only counts', () => {
  const rows = [
    referralRow(referral('p', '2026-03-01', [{ startedAt: d('2026-03-01'), pipelineStatus: 'HIRED_660', changes: [] }]), FINISHED, NOW),
    referralRow(referral('q', '2026-03-01'), FINISHED, NOW),
  ];
  const s = summarizeOutcomes(rows, { offPath: OFF, minCohort: 5, from: d('2026-03-01'), to: NOW });
  assert.equal(s.conversion, null);
  assert.equal(s.suppressed, true);
  assert.equal(s.placed, 1);
  assert.equal(s.referred, 2);
  assert.deepEqual(flooredRate(2, 5, 5), { rate: 40, suppressed: false });
  assert.deepEqual(flooredRate(0, 0, 5), { rate: null, suppressed: true });
});

test('in-pipeline excludes placed, off-path and not-picked-up referrals', () => {
  const rows = [
    referralRow(referral('a', '2026-03-01', [{ startedAt: d('2026-03-01'), pipelineStatus: 'HIRED_660', changes: [] }]), FINISHED, NOW),
    referralRow(referral('b', '2026-03-01', [{ startedAt: d('2026-03-01'), pipelineStatus: 'INTERNSHIP_DROPPED_460', changes: [] }]), FINISHED, NOW),
    referralRow(referral('c', '2026-03-01', [{ startedAt: d('2026-03-01'), pipelineStatus: 'APPLICATION_100', changes: [] }]), FINISHED, NOW),
    referralRow(referral('e', '2026-03-01'), FINISHED, NOW),
  ];
  const s = summarizeOutcomes(rows, { offPath: OFF, minCohort: 5, from: d('2026-03-01'), to: NOW });
  assert.equal(s.inPipeline, 1);
  assert.equal(s.stages[''], 1);
});

test('the trend has one point per month, placements dated by the placement', () => {
  assert.deepEqual(monthsBetween(d('2025-11-15'), d('2026-02-01')), ['2025-11', '2025-12', '2026-01', '2026-02']);
  const rows = [
    referralRow(referral('a', '2026-01-10', [{ startedAt: d('2026-01-10'), pipelineStatus: 'HIRED_660', changes: [{ toStatus: 'HIRED_660', at: d('2026-03-05') }] }]), FINISHED, NOW),
  ];
  const s = summarizeOutcomes(rows, { offPath: OFF, minCohort: 5, from: d('2026-01-01'), to: d('2026-03-31') });
  assert.deepEqual(s.trend, [
    { month: '2026-01', referred: 1, placed: 0 },
    { month: '2026-02', referred: 0, placed: 0 },
    { month: '2026-03', referred: 0, placed: 1 },
  ]);
});
