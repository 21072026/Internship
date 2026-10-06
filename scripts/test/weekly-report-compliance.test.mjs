// Unit tests for the weekly-report compliance rule (#1917).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The edges the compliance screen turns on:
//   - an intern who owes nothing yet has rate null, never 0% (or they rank as
//     the worst offender on the list);
//   - "late" is measured against the week the report COVERS, not today;
//   - a draft is not a submission, and the week still running is not owed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// weeklyReportCompliance.ts imports `./week` without an extension (Next's
// resolver adds it); Node's does not, hence the resolve hook and the dynamic
// import below it.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  internshipWindow, expectedWeeks, complianceForRelation, rollUp, weekByWeek, INTERNSHIP_STAGE_KEY,
} = await import('../../src/lib/weeklyReportCompliance.ts');

const DAY = 24 * 60 * 60 * 1000;
const d = (iso) => new Date(iso);
// 2026-09-07 is a Monday.
const MON = (n) => new Date(Date.UTC(2026, 8, 7 + 7 * n));
const iso = (dates) => dates.map((x) => x.toISOString().slice(0, 10));

test('the window starts at the first move into the internship stage and ends at the move out', () => {
  const window = internshipWindow({
    pipelineStatus: 'INTERNSHIP_COMPLETED_490',
    startDate: d('2026-08-01T00:00:00Z'),
    completedAt: null,
    changes: [
      { fromStatus: INTERNSHIP_STAGE_KEY, toStatus: 'INTERNSHIP_COMPLETED_490', createdAt: d('2026-10-01T10:00:00Z') },
      { fromStatus: 'INTERNSHIP_STARTING_300', toStatus: INTERNSHIP_STAGE_KEY, createdAt: d('2026-09-02T09:00:00Z') },
    ],
  });
  assert.deepEqual(window, { start: d('2026-09-02T09:00:00Z'), end: d('2026-10-01T10:00:00Z') });
});

test('a relation sitting in the stage with no recorded move falls back to its start date', () => {
  const window = internshipWindow({ pipelineStatus: INTERNSHIP_STAGE_KEY, startDate: d('2026-09-07T00:00:00Z'), completedAt: null, changes: [] });
  assert.deepEqual(window, { start: d('2026-09-07T00:00:00Z'), end: null });
});

test('a relation that never interned has no window and owes nothing', () => {
  const window = internshipWindow({
    pipelineStatus: 'HIRED_660', startDate: d('2026-01-01T00:00:00Z'), completedAt: null,
    changes: [{ fromStatus: 'APPLICATION_100', toStatus: 'HIRED_660', createdAt: d('2026-02-01T00:00:00Z') }],
  });
  assert.equal(window, null);
  assert.deepEqual(expectedWeeks(window, d('2026-10-01T00:00:00Z')), []);
});

test('expected weeks: only full weeks inside the window that have already ended', () => {
  // Starts mid-week (Wed 9 Sep) → first owed week is Mon 14 Sep.
  const window = { start: d('2026-09-09T12:00:00Z'), end: null };
  // "Now" is Wed 7 Oct: weeks of 14, 21, 28 Sep have ended; 5 Oct is running.
  assert.deepEqual(iso(expectedWeeks(window, d('2026-10-07T12:00:00Z'))), ['2026-09-14', '2026-09-21', '2026-09-28']);
  // Ended mid-week (Thu 1 Oct): the week of 28 Sep is not owed either.
  assert.deepEqual(iso(expectedWeeks({ ...window, end: d('2026-10-01T00:00:00Z') }, d('2026-12-01T00:00:00Z'))), ['2026-09-14', '2026-09-21']);
  // A from/to range narrows the answer.
  assert.deepEqual(
    iso(expectedWeeks(window, d('2026-12-01T00:00:00Z'), { from: d('2026-09-21T00:00:00Z'), to: d('2026-10-05T00:00:00Z') })),
    ['2026-09-21', '2026-09-28']
  );
});

test('an intern whose first full week has not ended has rate null, not 0%', () => {
  const expected = expectedWeeks({ start: d('2026-10-05T08:00:00Z'), end: null }, d('2026-10-08T00:00:00Z'));
  assert.deepEqual(expected, []);
  const c = complianceForRelation({ expected, reports: [] });
  assert.equal(c.rate, null);
  assert.equal(c.expected, 0);
  assert.deepEqual(c.missing, []);
});

test('submitted, reviewed, missing and late are counted per expected week', () => {
  const expected = [MON(0), MON(1), MON(2), MON(3)];
  const c = complianceForRelation({
    expected,
    reports: [
      // On time: submitted the Friday of its own week.
      { weekStart: MON(0), status: 'APPROVED', submittedAt: new Date(MON(0).getTime() + 4 * DAY) },
      // Late: submitted on the Tuesday AFTER the week it covers.
      { weekStart: MON(1), status: 'SUBMITTED', submittedAt: new Date(MON(2).getTime() + 1 * DAY) },
      // A draft is not a submission: the week is missing.
      { weekStart: MON(2), status: 'DRAFT', submittedAt: null },
      // MON(3): nothing at all → missing.
      // The running week's report counts for nothing (it is not expected).
      { weekStart: MON(4), status: 'SUBMITTED', submittedAt: new Date(MON(4).getTime() + DAY) },
    ],
  });
  assert.equal(c.expected, 4);
  assert.equal(c.submitted, 2);
  assert.equal(c.reviewed, 1);
  assert.deepEqual(iso(c.missing), iso([MON(2), MON(3)]));
  assert.deepEqual(iso(c.late), iso([MON(1)]));
  assert.equal(c.rate, 0.5);
});

test('late is relative to the covered week, not to today', () => {
  // Submitted in the last millisecond of its own week: on time, however old it is now.
  const onTime = complianceForRelation({
    expected: [MON(0)],
    reports: [{ weekStart: MON(0), status: 'CHANGES_REQUESTED', submittedAt: new Date(MON(1).getTime() - 1) }],
  });
  assert.deepEqual(onTime.late, []);
  assert.equal(onTime.reviewed, 1);
  // A row from before submittedAt existed is not called late.
  const unknown = complianceForRelation({ expected: [MON(0)], reports: [{ weekStart: MON(0), status: 'SUBMITTED', submittedAt: null }] });
  assert.deepEqual(unknown.late, []);
  assert.equal(unknown.rate, 1);
});

test('the roll-up sums relations and keeps a null rate when nobody owes anything', () => {
  const a = complianceForRelation({ expected: [MON(0), MON(1)], reports: [{ weekStart: MON(0), status: 'APPROVED', submittedAt: MON(0) }] });
  const b = complianceForRelation({ expected: [], reports: [] });
  const total = rollUp([a, b]);
  assert.deepEqual(total, { relations: 2, reporting: 1, behind: 1, expected: 2, submitted: 1, reviewed: 1, missing: 1, late: 0, rate: 0.5 });
  assert.equal(rollUp([b]).rate, null);
  assert.equal(rollUp([]).rate, null);
});

test('week-by-week detail names each owed week’s state', () => {
  const rows = weekByWeek([MON(0), MON(1), MON(2)], [
    { weekStart: MON(0), status: 'APPROVED', submittedAt: MON(0) },
    { weekStart: MON(1), status: 'DRAFT', submittedAt: null },
  ]);
  assert.deepEqual(rows.map((r) => [r.state, r.late]), [['approved', false], ['draft', false], ['missing', false]]);
});
