// Unit tests for the sales team page's counts — src/lib/salesTeamRule.ts (#3779).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamBookCounts, canSeeRepOverdue } from '../../src/lib/salesTeamRule.ts';

const book = {
  rows: [
    { ownerId: 'a', pipelineStatus: 'NEW' },
    { ownerId: 'a', pipelineStatus: 'NEW' },
    { ownerId: 'a', pipelineStatus: 'WON' },
    { ownerId: 'b', pipelineStatus: 'NEW' },
  ],
  byStage: [{ stage: 'NEW', count: 3 }, { stage: 'WON', count: 1 }],
  byOwner: [{ ownerId: 'a', ownerName: 'Alpha', count: 3 }, { ownerId: 'b', ownerName: 'Bravo', count: 1 }],
  truncated: false,
};

test('stage strip from byStage, per-seller split from the rows, sellers without records at 0', () => {
  const c = teamBookCounts(book, [{ id: 'a', fullName: 'Alpha' }, { id: 'z', fullName: 'Zulu' }], new Map([['a', 2]]));
  assert.deepEqual(Object.fromEntries(c.byStage), { NEW: 3, WON: 1 });
  assert.equal(c.splitKnown, true);
  assert.deepEqual(c.people.map((p) => p.id), ['a', 'b', 'z']);
  assert.deepEqual(Object.fromEntries(c.people[0].byStage), { NEW: 2, WON: 1 });
  assert.equal(c.people[0].overdue, 2);
  assert.deepEqual(Object.fromEntries(c.people[1].byStage), { NEW: 1 });
  assert.equal(c.people[2].byStage.size, 0);
  assert.equal(c.people[2].overdue, 0);
  assert.equal(c.overdueTotal, 2);
});

test('overdue total counts every owner, even one not listed as a seller', () => {
  const c = teamBookCounts(book, [{ id: 'a', fullName: 'Alpha' }], new Map([['a', 2], ['gone', 3]]));
  assert.equal(c.overdueTotal, 5);
});

test('per-person overdue counts: admins and the dispatcher only, never a rep', () => {
  assert.equal(canSeeRepOverdue({ role: 'ADMIN', dispatcher: false }), true);
  assert.equal(canSeeRepOverdue({ role: 'MENTOR', dispatcher: true }), true);
  assert.equal(canSeeRepOverdue({ role: 'MENTOR', dispatcher: false }), false);
  assert.equal(canSeeRepOverdue({ role: null, dispatcher: false }), false);
});

test('a truncated book never guesses a split: the owner total only', () => {
  const c = teamBookCounts({ ...book, rows: book.rows.slice(0, 1), truncated: true }, [], new Map());
  assert.equal(c.splitKnown, false);
  assert.deepEqual(Object.fromEntries(c.people[0].byStage), { '': 3 });
  assert.deepEqual(Object.fromEntries(c.people[1].byStage), { '': 1 });
});
