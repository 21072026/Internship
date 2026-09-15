// Unit tests for the stage clock (#1724), and for the rule that an old no-op
// `StatusChange` must not restart it (#2264).
//
// Run: node --test --experimental-strip-types scripts/test/stage-clock.test.mjs
// (also covered by `npm run test:unit`).
//
// The module is client-safe and imports no Prisma, which is what lets a plain
// node test import it — keep it that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `stageClock.ts` imports `./pipeline` and `./offers` — the specifiers the
// app's bundler resolves and Node's ESM resolver does not. The hook closes that
// gap, and has to be installed before the module loads, hence the dynamic
// import (a static one would be hoisted above the register() call).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { stageEnteredAt, daysInStage } = await import('../../src/lib/stageClock.ts');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-01-01T00:00:00Z').getTime();
const at = (days) => new Date(T0 + days * DAY);
const now = T0 + 40 * DAY;

test('with no recorded moves the clock runs from the relation start', () => {
  assert.equal(stageEnteredAt({ startDate: at(0) }), T0);
  assert.equal(daysInStage({ startDate: at(0), statusChanges: [] }, now), 40);
});

test('the newest real move is what the clock reads, in any order', () => {
  const changes = [
    { fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(10) },
    { fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'INTERNSHIP_STARTING_300', createdAt: at(30) },
  ];
  assert.equal(daysInStage({ startDate: at(0), statusChanges: changes }, now), 10);
  assert.equal(daysInStage({ startDate: at(0), statusChanges: [...changes].reverse() }, now), 10);
});

test('a no-op row does not restart the clock', () => {
  // Thirty days stuck in one stage, with a no-op row written yesterday.
  const stuck = {
    startDate: at(0),
    statusChanges: [
      { fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(10) },
      { fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'INTERVIEW_PENDING_250', createdAt: at(39) },
    ],
  };
  // Read literally the answer would be 1, and a relation nobody has touched in
  // a month reads as fresh on the board, in the mentor list and in the overdue
  // report — which is the whole bug.
  assert.equal(daysInStage(stuck, now), 30);
});

test('a relation whose only row is a no-op runs from its start date', () => {
  const rel = {
    startDate: at(0),
    statusChanges: [{ fromStatus: 'APPLICATION_100', toStatus: 'APPLICATION_100', createdAt: at(39) }],
  };
  assert.equal(stageEnteredAt(rel), T0);
  assert.equal(daysInStage(rel, now), 40);
});

test('a row without from/to is trusted, because its query already filtered', () => {
  // This is the shape every `take: 1` caller passes: the query carries
  // REAL_STAGE_MOVE, so the row that arrives here IS a real move and the two
  // columns are not worth fetching.
  const rel = { startDate: at(0), statusChanges: [{ createdAt: at(30) }] };
  assert.equal(daysInStage(rel, now), 10);
});

test('a backdated start still wins over an older move (no negative dwell)', () => {
  const rel = {
    startDate: at(20),
    statusChanges: [{ fromStatus: 'APPLICATION_100', toStatus: 'HIREABLE_600', createdAt: at(5) }],
  };
  assert.equal(stageEnteredAt(rel), T0 + 20 * DAY);
  assert.equal(daysInStage(rel, now), 20);
});

test('ISO strings are accepted, since the browser gets the payload as JSON', () => {
  const rel = {
    startDate: at(0).toISOString(),
    statusChanges: [
      { fromStatus: 'A', toStatus: 'A', createdAt: at(39).toISOString() },
      { fromStatus: 'A', toStatus: 'B', createdAt: at(12).toISOString() },
    ],
  };
  assert.equal(daysInStage(rel, now), 28);
});
