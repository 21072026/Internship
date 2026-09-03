// Unit tests for the time-in-stage aggregation (#1427).
//
// Run: npm run test:stage-aging  (node --test --experimental-strip-types)
//
// The bug these tests pin down: the analytics card printed `days.length` — the
// number of completed stage VISITS — as a candidate count, so the same page
// reported "6 candidates" in the aging card and "1" in the funnel for the same
// stage. The two numbers are now returned separately and named for what they
// are; these assertions are what stops them from being conflated again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStageAging } from '../../src/lib/stageAging.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-01-01T00:00:00Z').getTime();
const at = (days) => new Date(T0 + days * DAY);
const row = (result, stage) => result.rows.find((r) => r.pipelineStatus === stage);

test('a candidate who leaves and re-enters a stage is two visits but one candidate', () => {
  // 100 → 250 → 100 → 250: APPLICATION_100 is visited twice by ONE person.
  const result = computeStageAging([
    {
      menteeId: 'mentee-a',
      startDate: at(0),
      statusChanges: [
        { fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(2) },
        { fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'APPLICATION_100', createdAt: at(5) },
        { fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(9) },
      ],
    },
  ]);

  const application = row(result, 'APPLICATION_100');
  assert.equal(application.visits, 2, 'two completed visits (0→2d and 5→9d)');
  assert.equal(application.candidates, 1, 'but only one distinct candidate');
  assert.equal(application.avgDays, 3, 'avg of 2d and 4d');
  assert.equal(application.medianDays, 3);

  // The stage the candidate currently sits in has one completed visit (2→5d).
  assert.equal(row(result, 'INTERVIEW_PENDING_250').visits, 1);
  assert.equal(row(result, 'INTERVIEW_PENDING_250').candidates, 1);
});

test('visits never undercount and candidates never overcount across people', () => {
  const mk = (menteeId) => ({
    menteeId,
    startDate: at(0),
    statusChanges: [
      { fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', createdAt: at(4) },
      { fromStatus: 'APPROVAL_PENDING_220', toStatus: 'APPLICATION_100', createdAt: at(6) },
      { fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', createdAt: at(10) },
    ],
  });
  const result = computeStageAging([mk('mentee-a'), mk('mentee-b')]);
  const application = row(result, 'APPLICATION_100');
  assert.equal(application.visits, 4, 'two visits each');
  assert.equal(application.candidates, 2, 'two people');
  for (const r of result.rows) {
    assert.ok(r.visits >= r.candidates, `${r.pipelineStatus}: visits must dominate candidates`);
  }
});

test('a candidate who never left a stage contributes nothing to that stage', () => {
  // The funnel counts this person in APPLICATION_100; aging cannot, because no
  // duration has completed. That asymmetry is exactly why the two cards must
  // not share a label.
  const result = computeStageAging([
    { menteeId: 'mentee-a', startDate: at(0), statusChanges: [] },
  ]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.droppedNonPositive, 0);
});

test('non-positive durations are reported, not silently swallowed', () => {
  // Two same-instant rows (a no-op stage write, #894): the measurement is
  // unusable, but the payload now says how many were discarded.
  const result = computeStageAging([
    {
      menteeId: 'mentee-a',
      startDate: at(0),
      statusChanges: [
        { fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', createdAt: at(0) },
        { fromStatus: 'APPROVAL_PENDING_220', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(0) },
      ],
    },
  ]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.droppedNonPositive, 2);
});

test('the date window keeps only visits that ENDED inside it', () => {
  const from = at(3).getTime();
  const to = at(20).getTime();
  const result = computeStageAging(
    [
      {
        menteeId: 'mentee-a',
        startDate: at(0),
        statusChanges: [
          // Left APPLICATION_100 on day 2 → outside the window.
          { fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', createdAt: at(2) },
          // Left APPROVAL_PENDING_220 on day 7 → inside the window.
          { fromStatus: 'APPROVAL_PENDING_220', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(7) },
        ],
      },
    ],
    (leftAt) => leftAt >= from && leftAt <= to
  );
  assert.equal(row(result, 'APPLICATION_100'), undefined);
  assert.equal(row(result, 'APPROVAL_PENDING_220').visits, 1);
  assert.equal(row(result, 'APPROVAL_PENDING_220').avgDays, 5);
});
