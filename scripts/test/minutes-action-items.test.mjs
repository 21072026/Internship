// Unit tests for the action-item lines of the minutes (#1849) —
// src/lib/minutesActionItems.ts, the text half of the to-do ↔ line sync.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseActionItems,
  findActionItem,
  setActionItemDone,
  normalizeActionText,
} from '../../src/lib/minutesActionItems.ts';

const body = [
  'Agreed on the plan.',
  '- [ ] Rewrite the CV summary',
  '  * [x] Book the mock interview ',
  '- [X] Send the portfolio link',
  '- not a checkbox line',
  '- [ ]',
  'Next session in two weeks.',
].join('\n');

test('parse: dash or star, any case of x, leading spaces; a bare checkbox is not an item', () => {
  assert.deepEqual(parseActionItems(body), [
    { line: 1, text: 'Rewrite the CV summary', done: false },
    { line: 2, text: 'Book the mock interview', done: true },
    { line: 3, text: 'Send the portfolio link', done: true },
  ]);
  assert.deepEqual(parseActionItems(''), []);
  assert.deepEqual(parseActionItems('plain prose\nmore prose'), []);
});

test('find: whitespace and case do not matter, wording does', () => {
  assert.equal(normalizeActionText('  Rewrite   the CV  Summary '), 'rewrite the cv summary');
  assert.equal(findActionItem(body, 'rewrite the cv summary')?.line, 1);
  assert.equal(findActionItem(body, 'Rewrite the CV'), null);
});

test('setActionItemDone: flips exactly one line, keeps the rest byte for byte, no-ops when gone or same', () => {
  const ticked = setActionItemDone(body, 'Rewrite the CV summary', true);
  assert.notEqual(ticked, body);
  assert.equal(ticked.split('\n')[1], '- [x] Rewrite the CV summary');
  assert.deepEqual(ticked.split('\n').filter((_, i) => i !== 1), body.split('\n').filter((_, i) => i !== 1));
  // Unticking keeps the author's own spelling of the surrounding line.
  const unticked = setActionItemDone(body, 'book the mock interview', false);
  assert.equal(unticked.split('\n')[2], '  * [ ] Book the mock interview ');
  assert.equal(setActionItemDone(body, 'Send the portfolio link', true), body);
  assert.equal(setActionItemDone(body, 'not there', true), body);
});
