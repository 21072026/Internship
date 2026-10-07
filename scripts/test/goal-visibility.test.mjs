// Unit tests for the one reader of "who may see this goal" (#1858) —
// src/lib/goalVisibilityRule.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The rule is authorization, so these pin down the boundary rather than the
// happy path: a PRIVATE goal is for its author alone (not the other side, not
// an admin), rows older than `createdById` resolve their author from the
// seat `createdByRole` names, and the SQL fragment the timeline pages with
// agrees with the JS filter on every row of a corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_VISIBILITIES,
  DEFAULT_GOAL_VISIBILITY,
  isGoalVisibility,
  goalAuthorId,
  canReachGoals,
  canReadGoal,
  canSetGoalVisibility,
  visibleGoals,
  readableGoalsWhere,
} from '../../src/lib/goalVisibilityRule.ts';

const rel = { mentorId: 'mentor-1', menteeId: 'mentee-1' };
const mentor = { id: 'mentor-1', role: 'MENTOR' };
const mentee = { id: 'mentee-1', role: 'MENTEE' };
const admin = { id: 'admin-1', role: 'ADMIN' };
const stranger = { id: 'mentor-2', role: 'MENTOR' };

const goal = (visibility, createdById, createdByRole = null) => ({ visibility, createdById, createdByRole });

test('the option list and its default', () => {
  assert.deepEqual([...GOAL_VISIBILITIES], ['PAIR', 'PROGRAM', 'PRIVATE']);
  assert.equal(DEFAULT_GOAL_VISIBILITY, 'PAIR');
  assert.equal(isGoalVisibility('PRIVATE'), true);
  assert.equal(isGoalVisibility('private'), false);
  assert.equal(isGoalVisibility(undefined), false);
});

test('reach: the two seats and an admin; a third mentor has no goals here at all', () => {
  assert.equal(canReachGoals(rel, mentor), true);
  assert.equal(canReachGoals(rel, mentee), true);
  assert.equal(canReachGoals(rel, admin), true);
  assert.equal(canReachGoals(rel, stranger), false);
});

test('PAIR and PROGRAM read exactly as every goal did before the column existed', () => {
  for (const v of ['PAIR', 'PROGRAM', '', 'SOMETHING_NEW']) {
    const g = goal(v, 'mentor-1', 'MENTOR');
    assert.equal(canReadGoal(g, rel, mentor), true, v);
    assert.equal(canReadGoal(g, rel, mentee), true, v);
    assert.equal(canReadGoal(g, rel, admin), true, v);
    assert.equal(canReadGoal(g, rel, stranger), false, v);
  }
});

test('PRIVATE: the author alone — not the other side, not the admin', () => {
  const mine = goal('PRIVATE', 'mentee-1', 'MENTEE');
  assert.equal(canReadGoal(mine, rel, mentee), true);
  assert.equal(canReadGoal(mine, rel, mentor), false);
  assert.equal(canReadGoal(mine, rel, admin), false);
  assert.equal(canReadGoal(mine, rel, stranger), false);
  // An admin's own private goal is the admin's.
  const admins = goal('PRIVATE', 'admin-1', 'ADMIN');
  assert.equal(canReadGoal(admins, rel, admin), true);
  assert.equal(canReadGoal(admins, rel, mentor), false);
});

test('author: createdById first, then the seat createdByRole names, else nobody', () => {
  assert.equal(goalAuthorId(goal('PAIR', 'x'), rel), 'x');
  assert.equal(goalAuthorId(goal('PAIR', null, 'MENTOR'), rel), 'mentor-1');
  assert.equal(goalAuthorId(goal('PAIR', null, 'MENTEE'), rel), 'mentee-1');
  assert.equal(goalAuthorId(goal('PAIR', null, 'ADMIN'), rel), null);
  assert.equal(goalAuthorId(goal('PAIR', null, null), rel), null);
  // A legacy row the mentor narrowed by hand still answers to the mentor…
  assert.equal(canReadGoal(goal('PRIVATE', null, 'MENTOR'), rel, mentor), true);
  assert.equal(canReadGoal(goal('PRIVATE', null, 'MENTOR'), rel, mentee), false);
  // …and one with no resolvable author answers to nobody rather than leaking.
  for (const viewer of [mentor, mentee, admin]) {
    assert.equal(canReadGoal(goal('PRIVATE', null, null), rel, viewer), false);
  }
});

test('the scope is the author\'s to change', () => {
  const mentors = goal('PAIR', 'mentor-1', 'MENTOR');
  assert.equal(canSetGoalVisibility(mentors, rel, mentor), true);
  assert.equal(canSetGoalVisibility(mentors, rel, mentee), false);
  assert.equal(canSetGoalVisibility(mentors, rel, admin), false);
  // Legacy row: the seat decides.
  assert.equal(canSetGoalVisibility(goal('PAIR', null, 'MENTEE'), rel, mentee), true);
  assert.equal(canSetGoalVisibility(goal('PAIR', null, 'MENTEE'), rel, mentor), false);
  // No author → the scope stays as it is.
  assert.equal(canSetGoalVisibility(goal('PAIR', null, 'ADMIN'), rel, admin), false);
});

test('visibleGoals keeps order and drops only what the viewer may not read', () => {
  const rows = [
    { id: 'a', ...goal('PAIR', 'mentor-1', 'MENTOR') },
    { id: 'b', ...goal('PRIVATE', 'mentee-1', 'MENTEE') },
    { id: 'c', ...goal('PRIVATE', 'mentor-1', 'MENTOR') },
    { id: 'd', ...goal('PROGRAM', 'admin-1', 'ADMIN') },
  ];
  assert.deepEqual(visibleGoals(rows, rel, mentor).map((g) => g.id), ['a', 'c', 'd']);
  assert.deepEqual(visibleGoals(rows, rel, mentee).map((g) => g.id), ['a', 'b', 'd']);
  assert.deepEqual(visibleGoals(rows, rel, admin).map((g) => g.id), ['a', 'd']);
  assert.deepEqual(visibleGoals(rows, rel, stranger), []);
});

test('the SQL fragment agrees with the JS filter on every row that has an author id', () => {
  // A tiny evaluator for the two shapes the fragment uses, so the test does
  // not need a database to prove the two readers answer alike.
  const matches = (where, row) =>
    where.OR.some((clause) =>
      Object.entries(clause).every(([col, cond]) =>
        cond && typeof cond === 'object' && 'not' in cond ? row[col] !== cond.not : row[col] === cond
      )
    );
  const corpus = [];
  for (const visibility of ['PAIR', 'PROGRAM', 'PRIVATE']) {
    for (const createdById of ['mentor-1', 'mentee-1', 'admin-1']) {
      corpus.push({ visibility, createdById, createdByRole: null });
    }
  }
  for (const viewer of [mentor, mentee, admin]) {
    const where = readableGoalsWhere(viewer);
    for (const row of corpus) {
      assert.equal(matches(where, row), canReadGoal(row, rel, viewer), `${viewer.id} on ${JSON.stringify(row)}`);
    }
  }
  assert.deepEqual(readableGoalsWhere({ id: 'u' }), { OR: [{ visibility: { not: 'PRIVATE' } }, { createdById: 'u' }] });
});
