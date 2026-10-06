// Unit tests for the executive dashboard's deterministic scores (#1895).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { trendPeriods, scoreOf, expressionOf, deltaOf, activeIn, isForward, TREND_PERIODS } = await import('../../src/lib/executiveScores.ts');

test('trend periods are equally long, contiguous, oldest first, ending on the selection', () => {
  const p = trendPeriods('2026-09-01', '2026-09-30');
  assert.equal(p.length, TREND_PERIODS);
  assert.deepEqual(p.at(-1), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(p.at(-2), { from: '2026-08-02', to: '2026-08-31' });
  for (let i = 1; i < p.length; i++) {
    assert.equal(Date.parse(p[i].from) - Date.parse(p[i - 1].to), 24 * 60 * 60 * 1000, 'no gap, no overlap');
  }
  assert.deepEqual(trendPeriods('2026-10-06', '2026-10-06', 2), [{ from: '2026-10-05', to: '2026-10-05' }, { from: '2026-10-06', to: '2026-10-06' }]);
});

test('a score is 100 × n ÷ d rounded once, and has no value without a denominator', () => {
  assert.equal(scoreOf(18, 28), 64);
  assert.equal(scoreOf(1, 8), 13); // 12.5 rounds up
  assert.equal(scoreOf(0, 5), 0);
  assert.equal(scoreOf(0, 0), null);
  assert.equal(expressionOf({ numerator: 18, denominator: 28, score: 64 }), '100 × 18 ÷ 28 = 64');
  assert.equal(expressionOf({ numerator: 0, denominator: 0, score: null }), '0 ÷ 0 = n/a');
});

test('the delta compares the last two periods and is unknown when either is', () => {
  const pt = (score) => ({ period: { from: '', to: '' }, numerator: 0, denominator: 0, score });
  assert.equal(deltaOf([pt(50), pt(60), pt(56)]), -4);
  assert.equal(deltaOf([pt(null), pt(56)]), null);
  assert.equal(deltaOf([pt(56)]), null);
});

test('active in a period: started before it ended, and not completed before it began', () => {
  const sep = { from: '2026-09-01', to: '2026-09-30' };
  const d = (s) => new Date(`${s}T12:00:00Z`);
  assert.equal(activeIn({ startDate: d('2026-08-01'), status: 'ACTIVE', completedAt: null }, sep), true);
  assert.equal(activeIn({ startDate: d('2026-09-30'), status: 'ACTIVE', completedAt: null }, sep), true);
  assert.equal(activeIn({ startDate: d('2026-10-01'), status: 'ACTIVE', completedAt: null }, sep), false);
  assert.equal(activeIn({ startDate: d('2026-01-01'), status: 'COMPLETED', completedAt: d('2026-09-01') }, sep), true);
  assert.equal(activeIn({ startDate: d('2026-01-01'), status: 'COMPLETED', completedAt: d('2026-08-31') }, sep), false);
  // Completed with no recorded date: not placed in any period.
  assert.equal(activeIn({ startDate: d('2026-01-01'), status: 'COMPLETED', completedAt: null }, sep), false);
});

test('forward means later on the on-path order; off-path and unknown stages are never progress', () => {
  const onPath = ['APPLICATION_100', 'INTERVIEW_PENDING_250', 'HIRED_660'];
  assert.equal(isForward(onPath, 'APPLICATION_100', 'INTERVIEW_PENDING_250'), true);
  assert.equal(isForward(onPath, 'HIRED_660', 'INTERVIEW_PENDING_250'), false);
  assert.equal(isForward(onPath, 'INTERVIEW_PENDING_250', 'INTERNSHIP_DROPPED_460'), false);
  assert.equal(isForward(onPath, 'CUSTOM_X', 'HIRED_660'), false);
});
