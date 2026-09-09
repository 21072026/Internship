// Unit tests for the billable unit (#1750).
//
// Run: npm run test:metering  (node --test --experimental-strip-types)
//
// This is the number that goes on an invoice, so the assertions here are the
// sentence we publish, read back one clause at a time:
//
//   "a relation in ACTIVE state with any logged activity in the calendar
//    month; paused, benched and completed pairs are not counted"
//
// None of it can be pinned down in a browser: a month boundary cannot be
// crossed in an e2e run, "a future PAUSED state is excluded automatically" has
// no UI at all, and the difference between a counter and a recomputed metric —
// the thing that keeps a re-run of the nightly rollup from doubling a bill —
// is a property of the catalogue, not of a screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_MATCHED_PAIR_DEFINITION,
  ACTIVITY_SIGNALS,
  BILLABLE_RELATION_STATES,
  COMPUTED_METRICS,
  USAGE_METRICS,
  countBillablePairs,
  currentPeriod,
  isBillablePair,
  isBillableRelationState,
  isPeriod,
  isUsageMetric,
  periodOf,
  periodRange,
  previousPeriod,
  rollupPeriods,
} from '../../src/lib/meteringRules.ts';

const at = (iso) => new Date(iso);
const pair = (status, ...activity) => ({ status, activityAt: activity.map(at) });

// ── The definition, clause by clause ────────────────────────────────────────

test('an ACTIVE pair with a single logged interaction in the month is counted', () => {
  assert.equal(isBillablePair(pair('ACTIVE', '2026-03-14T09:00:00Z'), '2026-03'), true);
});

test('an ACTIVE pair with no activity in the month is NOT counted', () => {
  // The pair exists, it is active, nobody touched it in March. It is not
  // billable — this is the over-billing the plan-gate count would have done.
  const quiet = pair('ACTIVE', '2026-01-14T09:00:00Z');
  assert.equal(isBillablePair(quiet, '2026-03'), false);
  assert.equal(isBillablePair(quiet, '2026-01'), true, 'and it WAS billable in January');
});

test('an ACTIVE pair with no activity at all is NOT counted', () => {
  assert.equal(isBillablePair({ status: 'ACTIVE', activityAt: [] }, '2026-03'), false);
});

test('a COMPLETED pair is excluded even with activity in the month', () => {
  assert.equal(isBillablePair(pair('COMPLETED', '2026-03-14T09:00:00Z'), '2026-03'), false);
});

test('a dormant pair needs no special handling to fall out', () => {
  // `dormantSince` is deliberately not an input to this rule. A dormant
  // relation is one nobody has touched, so it has no activity row in the month
  // and the definition already excludes it. A relation that carries the stamp
  // and then comes back to life is billable again the moment something is
  // logged — no dormancy branch, in either direction.
  const wentQuietInJanuary = pair('ACTIVE', '2026-01-05T08:00:00Z');
  assert.equal(isBillablePair(wentQuietInJanuary, '2026-03'), false);
  const cameBack = pair('ACTIVE', '2026-01-05T08:00:00Z', '2026-03-30T16:00:00Z');
  assert.equal(isBillablePair(cameBack, '2026-03'), true);
});

test('the count is over pairs, not over activity rows', () => {
  const rows = [
    pair('ACTIVE', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
    pair('ACTIVE', '2026-03-04T00:00:00Z'),
    pair('ACTIVE', '2026-02-27T00:00:00Z'), // quiet in March
    pair('COMPLETED', '2026-03-05T00:00:00Z'), // finished
  ];
  assert.equal(countBillablePairs(rows, '2026-03'), 2);
});

test('the published definition is the string the code carries', () => {
  assert.match(ACTIVE_MATCHED_PAIR_DEFINITION, /ACTIVE state with any logged activity in the calendar month/);
  assert.match(ACTIVE_MATCHED_PAIR_DEFINITION, /paused, benched and completed pairs are not counted/);
});

// ── The month boundary ──────────────────────────────────────────────────────
// Half-open [gte, lt): the classic billing off-by-one is a row at exactly
// midnight landing in two months, or the last millisecond of a month landing
// in none.

test('the first instant of the month counts, the last instant of the previous one does not', () => {
  assert.equal(isBillablePair(pair('ACTIVE', '2026-03-01T00:00:00.000Z'), '2026-03'), true);
  assert.equal(isBillablePair(pair('ACTIVE', '2026-02-28T23:59:59.999Z'), '2026-03'), false);
});

test('the last instant of the month counts, the first of the next does not', () => {
  assert.equal(isBillablePair(pair('ACTIVE', '2026-03-31T23:59:59.999Z'), '2026-03'), true);
  assert.equal(isBillablePair(pair('ACTIVE', '2026-04-01T00:00:00.000Z'), '2026-03'), false);
});

test('a month is a UTC month, not the reader\'s month', () => {
  // 2026-04-01T01:30+03:00 is still 2026-03-31 in UTC. Whichever zone the
  // browser is in, both sides of an invoice have to agree on the month.
  assert.equal(periodOf(at('2026-04-01T01:30:00+03:00')), '2026-03');
  assert.equal(periodOf(at('2026-03-31T22:30:00-05:00')), '2026-04');
});

test('periodRange is a half-open UTC window, and December rolls the year', () => {
  assert.deepEqual(periodRange('2026-01'), {
    gte: at('2026-01-01T00:00:00.000Z'),
    lt: at('2026-02-01T00:00:00.000Z'),
  });
  assert.deepEqual(periodRange('2026-12'), {
    gte: at('2026-12-01T00:00:00.000Z'),
    lt: at('2027-01-01T00:00:00.000Z'),
  });
  // A leap February is 29 days without anybody saying so.
  assert.deepEqual(periodRange('2028-02').lt, at('2028-03-01T00:00:00.000Z'));
  assert.equal(isBillablePair(pair('ACTIVE', '2028-02-29T12:00:00Z'), '2028-02'), true);
});

test('a malformed period is refused rather than silently billed', () => {
  for (const bad of ['2026-13', '2026-00', '2026-1', '202603', 'March', '']) {
    assert.equal(isPeriod(bad), false, `${bad} should not parse as a period`);
    assert.throws(() => periodRange(bad), /Invalid billing period/);
  }
});

test('previousPeriod steps back across a year boundary', () => {
  assert.equal(previousPeriod('2026-01'), '2025-12');
  assert.equal(previousPeriod('2026-03'), '2026-02');
  assert.equal(currentPeriod(at('2026-03-14T09:00:00Z')), '2026-03');
  // The nightly rollup refreshes the open month and the one before it.
  assert.deepEqual(rollupPeriods(at('2026-01-02T02:40:00Z')), ['2026-01', '2025-12']);
});

// ── The allowlist ───────────────────────────────────────────────────────────

test('billable states are an allowlist, so a future PAUSED state is excluded for free', () => {
  assert.deepEqual([...BILLABLE_RELATION_STATES], ['ACTIVE']);
  assert.equal(isBillableRelationState('ACTIVE'), true);
  for (const notBillable of ['COMPLETED', 'PAUSED', 'BENCHED', 'ARCHIVED', '', null, undefined]) {
    assert.equal(isBillableRelationState(notBillable), false, `${notBillable} must not be billable`);
  }
  // Which is the whole point: a lifecycle state that does not exist yet is
  // already excluded from every query, because every query reads this one
  // constant. Making it billable later is this array plus nothing else.
  assert.equal(isBillablePair(pair('PAUSED', '2026-03-14T09:00:00Z'), '2026-03'), false);
  assert.equal(isBillablePair(pair('BENCHED', '2026-03-14T09:00:00Z'), '2026-03'), false);
});

// ── The activity signals ────────────────────────────────────────────────────

test('every per-relation activity signal is in the list, and each names its timestamp', () => {
  const byRelation = new Map(ACTIVITY_SIGNALS.map((s) => [s.relation, s.at]));
  // The seven signals #1750 enumerates. A signal dropped from this list would
  // silently stop making pairs billable — an under-count nobody sees.
  assert.deepEqual(
    [...byRelation.keys()].sort(),
    ['goals', 'meetingRequests', 'meetings', 'messages', 'statusChanges', 'weeklyReports', 'interactions'].sort(),
  );
  // An interaction is dated when it HAPPENED, not when it was typed: a
  // conversation on Friday logged on Monday belongs to Friday's month.
  assert.equal(byRelation.get('interactions'), 'date');
  for (const [relation, column] of byRelation) {
    if (relation !== 'interactions') assert.equal(column, 'createdAt');
  }
});

// ── The metric catalogue (what makes the rollup idempotent) ─────────────────

test('the billing metrics are recomputed, the volume metrics are counted', () => {
  // The distinction IS the idempotency guarantee: a COMPUTED metric is written
  // absolutely, so re-running a closed period writes the same value again. If
  // ACTIVE_MATCHED_PAIRS ever became a counter, a second nightly run would
  // double somebody's invoice.
  assert.equal(USAGE_METRICS.ACTIVE_MATCHED_PAIRS.kind, 'COMPUTED');
  assert.equal(USAGE_METRICS.ADMIN_SEATS.kind, 'COMPUTED');
  assert.equal(USAGE_METRICS.VIDEO_ROOM.kind, 'COUNTER');
  assert.equal(USAGE_METRICS.VIDEO_PARTICIPANT.kind, 'COUNTER');
  assert.equal(USAGE_METRICS.ACTIVE_PAIR_ACTIVITY.kind, 'COUNTER');

  // The rollup only ever recomputes the COMPUTED ones — the list it iterates
  // is derived from the catalogue rather than typed out a second time.
  assert.deepEqual([...COMPUTED_METRICS].sort(), ['ACTIVE_MATCHED_PAIRS', 'ADMIN_SEATS']);
  assert.equal(
    COMPUTED_METRICS.every((m) => USAGE_METRICS[m].kind === 'COMPUTED'),
    true,
  );
  // And the pair count carries the published sentence as its description, so a
  // usage screen cannot label it with something it invented.
  assert.equal(USAGE_METRICS.ACTIVE_MATCHED_PAIRS.what, ACTIVE_MATCHED_PAIR_DEFINITION);
});

test('an unknown metric name is not a metric', () => {
  assert.equal(isUsageMetric('ACTIVE_MATCHED_PAIRS'), true);
  assert.equal(isUsageMetric('ACTIVE_PAIRS'), false);
  assert.equal(isUsageMetric('toString'), false, 'inherited object properties are not metrics');
});
