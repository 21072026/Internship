// Unit tests for the proficiency rule on UserSkill (#1822).
//
// Pins the three properties the history depends on: an unchanged value writes
// no change, a confirmation never survives a change of value, and a curator's
// merge never loses a rating nor trades a confirmed level for a self-rating.
//
// Run: npm run test:skill-taxonomy  (node --test --experimental-strip-types)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSkillLevel,
  mergedLevel,
  planSelfLevelChanges,
  selfLevelData,
} from '../../src/lib/skillLevelRule.ts';

const row = (skillId, level, extra = {}) => ({
  userSkillId: `us-${skillId}`,
  skillId,
  level,
  levelSource: level === null ? null : 'SELF',
  verifiedById: null,
  verifiedAt: null,
  ...extra,
});

test('isSkillLevel accepts 1..5 integers only', () => {
  for (const ok of [1, 2, 3, 4, 5]) assert.equal(isSkillLevel(ok), true);
  for (const bad of [0, 6, 2.5, '3', null, undefined, NaN]) assert.equal(isSkillLevel(bad), false);
});

test('setting the same value again plans no change', () => {
  const held = [row('react', 3), row('sql', null)];
  assert.deepEqual(planSelfLevelChanges(held, new Map([['react', 3]])), []);
});

test('a changed, a new and a cleared rating each plan exactly one change', () => {
  const held = [row('react', 3), row('sql', null), row('go', 2)];
  const changes = planSelfLevelChanges(held, new Map([['react', 4], ['sql', 1]]));
  assert.deepEqual(changes, [
    { userSkillId: 'us-react', fromLevel: 3, toLevel: 4 },
    { userSkillId: 'us-sql', fromLevel: null, toLevel: 1 },
    { userSkillId: 'us-go', fromLevel: 2, toLevel: null },
  ]);
});

test('a level for a skill the person does not hold is ignored', () => {
  assert.deepEqual(planSelfLevelChanges([row('react', 3)], new Map([['react', 3], ['rust', 5]])), []);
});

test('an out-of-range value never lands; it reads as unrated', () => {
  assert.deepEqual(planSelfLevelChanges([row('react', 3)], new Map([['react', 9]])), [
    { userSkillId: 'us-react', fromLevel: 3, toLevel: null },
  ]);
});

test('a self-assessed change drops the confirmation', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  assert.deepEqual(selfLevelData(4, now), {
    level: 4, levelSource: 'SELF', verifiedById: null, verifiedAt: null, levelUpdatedAt: now,
  });
  assert.equal(selfLevelData(null, now).levelSource, null);
});

test('merge: the loser\'s rating fills an unrated target', () => {
  assert.deepEqual(mergedLevel(row('t', null), row('l', 4)), {
    level: 4, levelSource: 'SELF', verifiedById: null, verifiedAt: null,
  });
});

test('merge: the target\'s own rating stands against a self-rated loser', () => {
  assert.equal(mergedLevel(row('t', 2), row('l', 5)), null);
});

test('merge: a confirmed loser beats a self-rated target, never the other way', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const confirmed = row('l', 3, { levelSource: 'MENTOR', verifiedById: 'm1', verifiedAt: at });
  assert.deepEqual(mergedLevel(row('t', 5), confirmed), {
    level: 3, levelSource: 'MENTOR', verifiedById: 'm1', verifiedAt: at,
  });
  const confirmedTarget = row('t', 2, { levelSource: 'MENTOR', verifiedById: 'm2', verifiedAt: at });
  assert.equal(mergedLevel(confirmedTarget, row('l', 5)), null);
});

test('merge: an unrated loser changes nothing', () => {
  assert.equal(mergedLevel(row('t', null), row('l', null)), null);
});

import { confirmLevelPlan } from '../../src/lib/skillLevelRule.ts';

test('confirming the standing value verifies it and writes no history', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const plan = confirmLevelPlan(3, 3, 'mentor-1', 'MENTOR', now);
  assert.equal(plan.change, null);
  assert.deepEqual(plan.data, { level: 3, levelSource: 'MENTOR', verifiedById: 'mentor-1', verifiedAt: now, levelUpdatedAt: now });
});

test('correcting the value while confirming writes exactly one change', () => {
  const plan = confirmLevelPlan(5, 3, 'mentor-1', 'MENTOR', new Date());
  assert.deepEqual(plan.change, { fromLevel: 5, toLevel: 3 });
  assert.deepEqual(confirmLevelPlan(null, 2, 'm', 'MENTOR', new Date()).change, { fromLevel: null, toLevel: 2 });
});
