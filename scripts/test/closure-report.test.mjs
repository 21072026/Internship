// The closure report (#1795): src/lib/closureReport.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { buildClosureReport, closureOutcome } = await import('../../src/lib/closureReport.ts');

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-01-01T00:00:00Z');
const rel = (lifecycleState, endReasonCode, days, answers = [], invited = answers.length) => ({
  lifecycleState,
  endReasonCode,
  startDate: start,
  completedAt: new Date(start.getTime() + days * DAY),
  invited,
  answers,
});
const a = (overall, goalsMet, nps) => ({ overall, goalsMet, nps });

test('only COMPLETED is a success; every other ending is not a completion', () => {
  const r = buildClosureReport([rel('COMPLETED', 'finished', 90), rel('ENDED_EARLY', 'no_fit', 20), rel('ENDED_EARLY', 'mentor_unavailable', 40), rel('ENDED_REMATCHED', null, 10)]);
  assert.equal(r.relations, 4);
  assert.equal(r.successes, 1);
  const noFit = r.groups.find((g) => g.reasonCode === 'no_fit');
  assert.equal(noFit.success, false);
  assert.equal(noFit.outcome, 'ended_early');
  assert.equal(r.groups.filter((g) => g.success).length, 1);
});

test('live pairings are not endings', () => {
  assert.equal(closureOutcome('ACTIVE'), null);
  assert.equal(closureOutcome('PAUSED'), null);
  assert.equal(buildClosureReport([rel('ACTIVE', null, 5), rel('PAUSED', null, 5)]).relations, 0);
});

test('scores only above the response floor, residual included', () => {
  const five = [a(5, 4, 10), a(4, 4, 9), a(4, 3, 8), a(3, 3, 6), a(5, 5, 10)];
  const r = buildClosureReport([rel('COMPLETED', 'finished', 90, five), rel('ENDED_EARLY', 'no_fit', 20, [a(1, 1, 0)], 2)], 5);
  const done = r.groups.find((g) => g.outcome === 'completed');
  const early = r.groups.find((g) => g.outcome === 'ended_early');
  // One answer under the floor is hidden, and so is the shown group next to
  // the overall total (it would give the hidden one back by subtraction).
  assert.equal(early.scores, null);
  assert.equal(early.responses, null);
  assert.equal(done.scores, null);
  // Six answers overall: the totals are above the floor.
  assert.equal(r.scores.avgOverall, 3.7);
  assert.equal(r.responses, 6);
  assert.equal(r.invited, 7);
  assert.equal(r.responseRatePct, 86);
});

test('a group above the floor shows averages and NPS', () => {
  const answers = [a(5, 4, 10), a(4, 4, 9), a(4, 3, 8), a(3, 3, 6), a(5, 5, 10)];
  const r = buildClosureReport([rel('COMPLETED', 'finished', 90, answers)], 5);
  const g = r.groups[0];
  assert.equal(g.responses, 5);
  assert.equal(g.scores.avgOverall, 4.2);
  assert.equal(g.scores.avgGoalsMet, 3.8);
  assert.equal(g.scores.nps.suppressed, false);
  assert.equal(g.scores.nps.score, 40); // 3 promoters, 1 passive, 1 detractor
});

test('median length in days', () => {
  assert.equal(buildClosureReport([rel('COMPLETED', null, 10), rel('COMPLETED', null, 30), rel('ENDED_EARLY', 'no_fit', 20)]).medianLengthDays, 20);
  assert.equal(buildClosureReport([]).medianLengthDays, null);
});
