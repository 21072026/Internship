// Unit tests for the sales won-deal target + leaderboard rule — src/lib/salesTargetRule.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The properties that matter, each one a way a "light" gamification goes wrong:
//   • INTERNSHIP never gets it (leaderboards are a non-goal there);
//   • a transfer successor (starts in the won stage) is not a second win;
//   • a re-win is not a second win, and month boundaries are half-open UTC;
//   • a broken setting row never invents a target or switches the board on;
//   • ties share a rank — name order is display order, not a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  salesTargetApplies,
  parseWonTarget,
  isValidWonTargetInput,
  parseLeaderboardForReps,
  canSeeLeaderboard,
  wonByMoveAt,
  wonCountsByOwner,
  targetProgress,
  rankLeaderboard,
  SALES_TARGET_MAX,
} from '../../src/lib/salesTargetRule.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';
import { periodRange } from '../../src/lib/meteringRules.ts';

const WON = ['DEAL_WON'];
const at = (iso) => Date.parse(iso);
const move = (fromStatus, toStatus, iso) => ({ fromStatus, toStatus, at: at(iso) });

test('applies to MARKETING only, never to INTERNSHIP', () => {
  assert.equal(salesTargetApplies(verticalCapabilities('MARKETING')), true);
  assert.equal(salesTargetApplies(verticalCapabilities('INTERNSHIP')), false);
  assert.equal(salesTargetApplies([]), false);
});

test('target parsing: positive whole numbers only, everything else is "no target"', () => {
  assert.equal(parseWonTarget('12'), 12);
  assert.equal(parseWonTarget(' 3 '), 3);
  for (const raw of ['', '0', '-2', '1.5', 'abc', '12345', null, undefined]) assert.equal(parseWonTarget(raw), null, String(raw));
  assert.equal(parseWonTarget(String(SALES_TARGET_MAX)), SALES_TARGET_MAX);
  assert.equal(isValidWonTargetInput(''), true);
  assert.equal(isValidWonTargetInput('0'), true);
  assert.equal(isValidWonTargetInput('9999'), true);
  assert.equal(isValidWonTargetInput('10000'), false);
  assert.equal(isValidWonTargetInput('-1'), false);
});

test('leaderboard flag: only the literal "true" switches it on; admins always see it', () => {
  assert.equal(parseLeaderboardForReps('true'), true);
  for (const raw of ['false', '', 'TRUE', '1', null, undefined]) assert.equal(parseLeaderboardForReps(raw), false);
  assert.equal(canSeeLeaderboard('ADMIN', false), true);
  assert.equal(canSeeLeaderboard('MENTOR', false), false);
  assert.equal(canSeeLeaderboard('MENTOR', true), true);
  assert.equal(canSeeLeaderboard('MENTEE', true), false);
  assert.equal(canSeeLeaderboard('COMPANY', true), false);
  assert.equal(canSeeLeaderboard(undefined, true), false);
});

test('won by move: the first arrival at a won stage', () => {
  assert.equal(wonByMoveAt([move('LEAD_NEW', 'TRIAL_ACTIVE', '2026-10-01'), move('TRIAL_ACTIVE', 'DEAL_WON', '2026-10-05')], WON), at('2026-10-05'));
  // re-won later: still the first win
  assert.equal(
    wonByMoveAt([move('TRIAL_ACTIVE', 'DEAL_WON', '2026-09-20'), move('DEAL_WON', 'DEAL_LOST', '2026-09-25'), move('DEAL_LOST', 'DEAL_WON', '2026-10-02')], WON),
    at('2026-09-20'),
  );
  assert.equal(wonByMoveAt([move('LEAD_NEW', 'TRIAL_ACTIVE', '2026-10-01')], WON), null);
  assert.equal(wonByMoveAt([], WON), null);
  assert.equal(wonByMoveAt([move('LEAD_NEW', 'DEAL_WON', '2026-10-01')], []), null);
});

test('a deal whose history starts in a won stage (transfer successor, import) is not a win', () => {
  assert.equal(wonByMoveAt([move('DEAL_WON', 'DEAL_LOST', '2026-10-01'), move('DEAL_LOST', 'DEAL_WON', '2026-10-03')], WON), null);
});

test('counts per owner inside the half-open UTC month', () => {
  const oct = periodRange('2026-10');
  const deals = [
    { ownerId: 'a', moves: [move('T', 'DEAL_WON', '2026-10-01T00:00:00Z')] }, // first instant: in
    { ownerId: 'a', moves: [move('T', 'DEAL_WON', '2026-10-31T23:59:59.999Z')] }, // last instant: in
    { ownerId: 'a', moves: [move('T', 'DEAL_WON', '2026-11-01T00:00:00Z')] }, // next month: out
    { ownerId: 'b', moves: [move('T', 'DEAL_WON', '2026-09-30T23:59:59.999Z')] }, // previous month: out
    { ownerId: 'b', moves: [move('T', 'DEAL_WON', '2026-10-10T12:00:00Z')] },
    { ownerId: 'c', moves: [move('T', 'X', '2026-10-10T12:00:00Z')] },
    { ownerId: 'd', moves: [move('DEAL_WON', 'DEAL_WON', '2026-10-10T12:00:00Z')] },
  ];
  const counts = wonCountsByOwner(deals, WON, oct);
  assert.deepEqual(Object.fromEntries(counts), { a: 2, b: 1 });
});

test('a transfer chain is one deal: a re-win after a handover is not a second win', () => {
  const oct = periodRange('2026-10');
  // A wins in September, loses, hands over; B re-wins in October.
  const chain = [
    { id: 'r1', previousId: null, ownerId: 'a', moves: [move('TRIAL', 'DEAL_WON', '2026-09-10'), move('DEAL_WON', 'DEAL_LOST', '2026-09-20')] },
    { id: 'r2', previousId: 'r1', ownerId: 'b', moves: [move('DEAL_LOST', 'DEAL_WON', '2026-10-05')] },
  ];
  assert.deepEqual(Object.fromEntries(wonCountsByOwner(chain, WON, oct)), {});
  // The September win stays A's, counted once.
  assert.deepEqual(Object.fromEntries(wonCountsByOwner(chain, WON, periodRange('2026-09'))), { a: 1 });
  // Same chain, both wins in October: still one win, A's.
  const sameMonth = [
    { id: 'r1', previousId: null, ownerId: 'a', moves: [move('TRIAL', 'DEAL_WON', '2026-10-02'), move('DEAL_WON', 'DEAL_LOST', '2026-10-03')] },
    { id: 'r2', previousId: 'r1', ownerId: 'b', moves: [move('DEAL_LOST', 'DEAL_WON', '2026-10-05')] },
  ];
  assert.deepEqual(Object.fromEntries(wonCountsByOwner(sameMonth, WON, oct)), { a: 1 });
  // Never won before the handover: the successor's win is B's.
  const firstWinAfter = [
    { id: 'r1', previousId: null, ownerId: 'a', moves: [move('LEAD', 'TRIAL', '2026-09-10')] },
    { id: 'r2', previousId: 'r1', ownerId: 'b', moves: [move('TRIAL', 'DEAL_WON', '2026-10-05')] },
  ];
  assert.deepEqual(Object.fromEntries(wonCountsByOwner(firstWinAfter, WON, oct)), { b: 1 });
  // A three-link chain won in the middle link: only the middle owner, once.
  const three = [
    { id: 'r1', previousId: null, ownerId: 'a', moves: [move('LEAD', 'TRIAL', '2026-10-01')] },
    { id: 'r2', previousId: 'r1', ownerId: 'b', moves: [move('TRIAL', 'DEAL_WON', '2026-10-02'), move('DEAL_WON', 'DEAL_LOST', '2026-10-03')] },
    { id: 'r3', previousId: 'r2', ownerId: 'c', moves: [move('DEAL_LOST', 'DEAL_WON', '2026-10-04')] },
  ];
  assert.deepEqual(Object.fromEntries(wonCountsByOwner(three, WON, oct)), { b: 1 });
  // A cycle (no write path makes one) terminates.
  const cycle = [
    { id: 'x', previousId: 'y', ownerId: 'a', moves: [move('T', 'DEAL_WON', '2026-10-02')] },
    { id: 'y', previousId: 'x', ownerId: 'b', moves: [move('T', 'X', '2026-10-01')] },
  ];
  assert.equal(typeof wonCountsByOwner(cycle, WON, oct).size, 'number');
});

test('several won stages all count, once per deal', () => {
  const counts = wonCountsByOwner(
    [{ ownerId: 'a', moves: [move('T', 'WON_A', '2026-10-02'), move('WON_A', 'WON_B', '2026-10-03')] }],
    ['WON_A', 'WON_B'],
    periodRange('2026-10'),
  );
  assert.equal(counts.get('a'), 1);
});

test('target progress: bar caps at 100, the count does not', () => {
  assert.deepEqual(targetProgress(3, 10), { won: 3, target: 10, percent: 30, reached: false });
  assert.deepEqual(targetProgress(10, 10), { won: 10, target: 10, percent: 100, reached: true });
  assert.deepEqual(targetProgress(14, 10), { won: 14, target: 10, percent: 100, reached: true });
  assert.deepEqual(targetProgress(1, 3), { won: 1, target: 3, percent: 33, reached: false });
  assert.deepEqual(targetProgress(4, null), { won: 4, target: null, percent: null, reached: false });
  assert.deepEqual(targetProgress(0, 0), { won: 0, target: null, percent: null, reached: false });
});

test('leaderboard: most wins first, ties ordered by name and sharing a rank', () => {
  const ranked = rankLeaderboard([
    { userId: '1', name: 'Zoe', won: 2 },
    { userId: '2', name: 'anna', won: 2 },
    { userId: '3', name: 'Bert', won: 5 },
    { userId: '4', name: 'Cem', won: 0 },
    { userId: '5', name: 'Dora', won: 0 },
  ]);
  assert.deepEqual(
    ranked.map((r) => [r.rank, r.name, r.won]),
    [
      [1, 'Bert', 5],
      [2, 'anna', 2],
      [2, 'Zoe', 2],
      [4, 'Cem', 0],
      [4, 'Dora', 0],
    ],
  );
  assert.deepEqual(rankLeaderboard([]), []);
  // same name: id breaks the tie so the order is total and stable
  assert.deepEqual(rankLeaderboard([{ userId: 'b', name: 'X', won: 1 }, { userId: 'a', name: 'X', won: 1 }]).map((r) => r.userId), ['a', 'b']);
});

// ── The team page's week window and loss counter (#3779) ────────────────────

import { weekRange, earliestStart, lostCountsByOwner, totalOf } from '../../src/lib/salesTargetRule.ts';

test('weekRange: Monday 00:00 UTC to next Monday, half-open, whatever the weekday', () => {
  const iso = (d) => d.toISOString();
  // Wed 2026-11-11 → Mon 2026-11-09 … Mon 2026-11-16
  assert.deepEqual([iso(weekRange(new Date('2026-11-11T15:30:00Z')).gte), iso(weekRange(new Date('2026-11-11T15:30:00Z')).lt)], [
    '2026-11-09T00:00:00.000Z',
    '2026-11-16T00:00:00.000Z',
  ]);
  // Sunday late belongs to the week that started the Monday before.
  assert.equal(iso(weekRange(new Date('2026-11-15T23:59:59Z')).gte), '2026-11-09T00:00:00.000Z');
  // Monday 00:00 starts a new week (half-open, like periodRange).
  assert.equal(iso(weekRange(new Date('2026-11-16T00:00:00Z')).gte), '2026-11-16T00:00:00.000Z');
  // A week across a month boundary: Tue 2026-12-01 → Mon 2026-11-30.
  assert.equal(iso(weekRange(new Date('2026-12-01T08:00:00Z')).gte), '2026-11-30T00:00:00.000Z');
  // Across a year boundary: Fri 2027-01-01 → Mon 2026-12-28.
  assert.equal(iso(weekRange(new Date('2027-01-01T08:00:00Z')).gte), '2026-12-28T00:00:00.000Z');
});

test('earliestStart: the earlier window start (a week can begin in the previous month)', () => {
  const month = { gte: new Date('2026-12-01T00:00:00Z') };
  const week = { gte: new Date('2026-11-30T00:00:00Z') };
  assert.equal(earliestStart(month, week).toISOString(), '2026-11-30T00:00:00.000Z');
});

test('lostCountsByOwner: the first move into an off-path stage, inside the window; a deal that started lost is not a loss', () => {
  const at = (s) => Date.parse(s);
  const range = { gte: new Date('2026-11-09T00:00:00Z'), lt: new Date('2026-11-16T00:00:00Z') };
  const lost = ['LOST'];
  const deals = [
    { ownerId: 'a', moves: [{ fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-10T10:00:00Z') }] },
    // lost last week, revived and lost again this week: one loss, last week.
    {
      ownerId: 'a',
      moves: [
        { fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-03T10:00:00Z') },
        { fromStatus: 'LOST', toStatus: 'NEW', at: at('2026-11-04T10:00:00Z') },
        { fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-11T10:00:00Z') },
      ],
    },
    // created lost (history starts off-path): never a loss by a move.
    { ownerId: 'b', moves: [{ fromStatus: 'LOST', toStatus: 'NEW', at: at('2026-11-10T10:00:00Z') }, { fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-11T10:00:00Z') }] },
    { ownerId: 'b', moves: [{ fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-15T23:59:59Z') }] },
    // Monday 00:00 of the next week is outside.
    { ownerId: 'c', moves: [{ fromStatus: 'NEW', toStatus: 'LOST', at: at('2026-11-16T00:00:00Z') }] },
    { ownerId: 'c', moves: [] },
  ];
  const counts = lostCountsByOwner(deals, lost, range);
  assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 1 });
  assert.equal(totalOf(counts), 2);
  assert.equal(lostCountsByOwner(deals, [], range).size, 0);
});
