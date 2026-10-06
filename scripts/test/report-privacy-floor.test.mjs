// Unit tests for the report privacy floor and the registry definitions (#1903).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The floor is the part a works council will test first: a group smaller than
// the minimum is never shown on its own, it is merged into one named bucket,
// and the counts still reconcile with the total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { applyMinCohort, SUPPRESSED_LABEL } = await import('../../src/lib/reports/privacyFloor.ts');
const { REPORT_DEFINITIONS, getReportDefinition, DEFAULT_MIN_COHORT } = await import('../../src/lib/reports/definitions.ts');

const cohorts = getReportDefinition('cohort-comparison');
const opts = { columns: cohorts.columns, sizeColumn: 'total', labelColumn: 'cohort', minCohort: 5 };
const sum = (rows, key) => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);

test('groups below the floor are merged into one named bucket and the totals reconcile', () => {
  const rows = [
    { cohort: 'Spring', total: 12, inProgress: 4, reachedOutcome: 6, dropped: 2, conversion: 50, avgDaysToOutcome: 40 },
    { cohort: 'Tiny A', total: 3, inProgress: 1, reachedOutcome: 1, dropped: 1, conversion: 33, avgDaysToOutcome: 20 },
    { cohort: 'Tiny B', total: 2, inProgress: 2, reachedOutcome: 0, dropped: 0, conversion: 0, avgDaysToOutcome: null },
  ];
  const { rows: out, suppressedGroups } = applyMinCohort(rows, opts);
  assert.equal(suppressedGroups, 2);
  assert.deepEqual(out.map((r) => r.cohort), ['Spring', SUPPRESSED_LABEL]);
  // Counts add up to exactly what they did before suppression.
  for (const key of ['total', 'inProgress', 'reachedOutcome', 'dropped']) assert.equal(sum(out, key), sum(rows, key), key);
  // Ratios and averages over a merged bucket are not invented.
  const bucket = out[1];
  assert.equal(bucket.conversion, null);
  assert.equal(bucket.avgDaysToOutcome, null);
  assert.equal(bucket.total, 5);
});

test('nothing below the floor → rows untouched, nothing suppressed', () => {
  const rows = [{ cohort: 'A', total: 5 }, { cohort: 'B', total: 9 }];
  const result = applyMinCohort(rows, opts);
  assert.equal(result.suppressedGroups, 0);
  assert.equal(result.rows, rows);
});

test('a bucket that is itself small is still emitted — its members cannot be told apart', () => {
  const { rows } = applyMinCohort([{ cohort: 'One', total: 1 }, { cohort: 'Two', total: 2 }], opts);
  assert.deepEqual(rows, [{ cohort: SUPPRESSED_LABEL, total: 3, inProgress: 0, reachedOutcome: 0, dropped: 0, conversion: null, avgDaysToOutcome: null }]);
});

test('every aggregate definition names its size and label columns, and keys are unique', () => {
  const keys = REPORT_DEFINITIONS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length);
  // The six the Program tier promises (#1903) are always there; more may join.
  for (const k of ['pipeline-funnel', 'cohort-comparison', 'source-conversion', 'mentor-workload', 'placement-outcomes', 'weekly-report-compliance']) {
    assert.ok(keys.includes(k), k);
  }
  for (const d of REPORT_DEFINITIONS.filter((d) => d.aggregate)) {
    const cols = d.columns.map((c) => c.key);
    assert.ok(cols.includes(d.sizeColumn), `${d.key} sizeColumn`);
    assert.ok(cols.includes(d.labelColumn), `${d.key} labelColumn`);
    assert.ok((d.minCohort ?? DEFAULT_MIN_COHORT) >= DEFAULT_MIN_COHORT, `${d.key} may raise the floor, never lower it`);
  }
});
