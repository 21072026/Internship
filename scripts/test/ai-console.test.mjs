// The /admin/ai console's arithmetic (#2030): folding the SQL groupBy rows into
// per-task rows, the nearest-rank percentile index, success rate, spend
// formatting and the month selector.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { foldUsage, percentileIndex, successRate, formatUsd, recentPeriods } = await import('../../src/lib/ai/consoleRules.ts');

test('groupBy rows fold into one row per task, outcomes split, most-called first, with totals', () => {
  const { tasks, totals } = foldUsage(
    [
      { scope: 'cv_feedback', outcome: 'ok', calls: 8, inputTokens: 8000, outputTokens: 1600, costMicros: 120_000 },
      { scope: 'cv_feedback', outcome: 'parse_error', calls: 1, inputTokens: 900, outputTokens: 10, costMicros: 9_000 },
      { scope: 'cv_feedback', outcome: 'provider_error', calls: 2, inputTokens: 0, outputTokens: 0, costMicros: 0 },
      { scope: 'interview_prep', outcome: 'ok', calls: 3, inputTokens: 300, outputTokens: 900, costMicros: 0 },
    ],
    { interview_prep: 3 },
    { cv_feedback: { p50: 1200, p95: 4000 } },
  );
  assert.deepEqual(tasks.map((t) => t.task), ['cv_feedback', 'interview_prep']);
  assert.deepEqual(
    { ...tasks[0] },
    { task: 'cv_feedback', calls: 11, ok: 8, parseErrors: 1, providerErrors: 2, inputTokens: 8900, outputTokens: 1610, costMicros: 129_000, unpricedCalls: 0, p50LatencyMs: 1200, p95LatencyMs: 4000 },
  );
  assert.equal(tasks[1].unpricedCalls, 3);
  assert.equal(tasks[1].p95LatencyMs, null);
  assert.deepEqual(totals, { calls: 14, ok: 11, parseErrors: 1, providerErrors: 2, inputTokens: 9200, outputTokens: 2510, costMicros: 129_000, unpricedCalls: 3 });
});

test('nearest-rank percentile index', () => {
  assert.equal(percentileIndex(0, 0.5), null);
  assert.equal(percentileIndex(1, 0.95), 0);
  assert.equal(percentileIndex(10, 0.5), 4);
  assert.equal(percentileIndex(10, 0.95), 9);
  assert.equal(percentileIndex(100, 0.95), 94);
  assert.equal(percentileIndex(3, 0.5), 1);
});

test('success rate counts only ok — an unreadable reply is not a success', () => {
  assert.equal(successRate({ calls: 0, ok: 0 }), null);
  assert.equal(successRate({ calls: 11, ok: 8 }), 73);
});

test('spend is formatted from micro-dollars, a tiny non-zero spend is not shown as $0.00', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(129_000), '$0.13');
  assert.equal(formatUsd(1_234), '<$0.01');
  assert.equal(formatUsd(12_340_000), '$12.34');
});

test('the month selector lists the last twelve periods, newest first, across a year boundary', () => {
  const p = recentPeriods('2026-02');
  assert.equal(p.length, 12);
  assert.deepEqual(p.slice(0, 3), ['2026-02', '2026-01', '2025-12']);
  assert.equal(p[11], '2025-03');
});
