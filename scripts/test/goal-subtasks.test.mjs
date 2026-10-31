// Unit tests for a goal's sub-tasks and pooled wording (#1860) —
// src/lib/goalSubtasksRule.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Pinned: progress derives from the steps once there are any (and the manual
// figure answers only without them); a pooled goal is never reworded and is
// deleted only by whoever handed it out or an admin; a step is ticked by any
// reader of the goal but reworded or deleted only by its author or an admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivedGoalProgress, canRewordGoal, canDeleteGoal, subtaskPermissions } from '../../src/lib/goalSubtasksRule.ts';

test('progress derives from the steps, the manual figure only without them', () => {
  assert.equal(derivedGoalProgress(40, []), 40);
  assert.equal(derivedGoalProgress(null, []), null);
  assert.equal(derivedGoalProgress(90, [{ done: true }, { done: false }, { done: false }]), 33);
  assert.equal(derivedGoalProgress(null, [{ done: true }, { done: true }]), 100);
  assert.equal(derivedGoalProgress(null, [{ done: false }]), 0);
});

test('a pooled goal keeps the pool wording and only its giver or an admin deletes it', () => {
  const pooled = { templateId: 't1', createdById: 'mentor' };
  const own = { templateId: null, createdById: 'mentee' };
  assert.equal(canRewordGoal(pooled), false);
  assert.equal(canRewordGoal(own), true);
  assert.equal(canDeleteGoal(pooled, { id: 'mentee', isAdmin: false }), false);
  assert.equal(canDeleteGoal(pooled, { id: 'mentor', isAdmin: false }), true);
  assert.equal(canDeleteGoal(pooled, { id: 'someone', isAdmin: true }), true);
  assert.equal(canDeleteGoal(own, { id: 'mentor', isAdmin: false }), true);
});

test('a step: any reader ticks it; its author or an admin rewords and deletes it; the assignee deletes a hand-written one', () => {
  const byMentor = { templateId: null, createdById: 'mentor', assigneeId: 'mentee' };
  assert.deepEqual(subtaskPermissions(byMentor, { id: 'mentee', isAdmin: false }), { canCheck: true, canEdit: false, canDelete: true });
  assert.deepEqual(subtaskPermissions(byMentor, { id: 'mentor', isAdmin: false }), { canCheck: true, canEdit: true, canDelete: true });
  assert.deepEqual(subtaskPermissions({ ...byMentor, templateId: 't' }, { id: 'mentee', isAdmin: false }), { canCheck: true, canEdit: false, canDelete: false });
  assert.deepEqual(subtaskPermissions({ ...byMentor, templateId: 't' }, { id: 'mentor', isAdmin: false }), { canCheck: true, canEdit: false, canDelete: true });
  assert.deepEqual(subtaskPermissions({ templateId: null, createdById: 'mentee', assigneeId: 'mentee' }, { id: 'mentor', isAdmin: false }), { canCheck: true, canEdit: false, canDelete: false });
  assert.deepEqual(subtaskPermissions(byMentor, { id: 'admin', isAdmin: true }), { canCheck: true, canEdit: true, canDelete: true });
});
