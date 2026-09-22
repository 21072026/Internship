// Unit tests for the to-do privacy rule (#1113, #2440).
//
// Run: node --test --experimental-strip-types scripts/test/todo-visibility.test.mjs
// (also covered by `npm run test:unit`).
//
// The sentence under test: a line somebody wrote for themselves on their own
// list stays theirs. It is enforced in SQL when one person's list is opened and
// by this predicate everywhere the reader spans many owners — the ?scope=team
// list and, the reason these tests exist, the overdue block of the daily
// activity digest, which mails other people's late to-dos to their mentor and
// to every admin in the organisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isPrivateSelfTodo, visibleToViewer } = await import('../../src/lib/todoVisibility.ts');

const mine = { projectId: null, createdById: 'mentee', assigneeId: 'mentee' };
const handedOver = { projectId: null, createdById: 'mentor', assigneeId: 'mentee' };
const fromProject = { projectId: 'p1', createdById: 'mentee', assigneeId: 'mentee' };
const authorless = { projectId: null, createdById: null, assigneeId: 'mentee' };

test('a line you wrote for yourself on your own list is private', () => {
  assert.equal(isPrivateSelfTodo(mine), true);
});

test('anything somebody else put there, or a project did, is not', () => {
  assert.equal(isPrivateSelfTodo(handedOver), false);
  assert.equal(isPrivateSelfTodo(fromProject), false);
  // Mirrors the SQL form: `createdById: { not: ownerId }` matches a NULL author
  // in Prisma, so a row with no recorded author stays readable.
  assert.equal(isPrivateSelfTodo(authorless), false);
  // A project to-do is the team's even when the assignee wrote it themselves.
  assert.equal(
    isPrivateSelfTodo({ projectId: 'p1', createdById: 'mentee', assigneeId: 'mentee' }),
    false
  );
});

test('a many-owner list drops other people’s private lines and keeps the rest', () => {
  const rows = [mine, handedOver, fromProject, authorless];
  const asMentor = visibleToViewer(rows, 'mentor');
  assert.deepEqual(asMentor, [handedOver, fromProject, authorless]);
  // This is the one the digest would otherwise have e-mailed.
  assert.equal(asMentor.includes(mine), false);
});

test('your own private lines are still yours to read', () => {
  const rows = [mine, handedOver];
  assert.deepEqual(visibleToViewer(rows, 'mentee'), [mine, handedOver]);
});

test('an admin reading the whole organisation is no more privileged', () => {
  const someoneElses = { projectId: null, createdById: 'u9', assigneeId: 'u9' };
  const adminsOwn = { projectId: null, createdById: 'admin', assigneeId: 'admin' };
  const visible = visibleToViewer([someoneElses, adminsOwn, handedOver], 'admin');
  assert.deepEqual(visible, [adminsOwn, handedOver]);
});

test('an empty list is an empty list', () => {
  assert.deepEqual(visibleToViewer([], 'anyone'), []);
});
