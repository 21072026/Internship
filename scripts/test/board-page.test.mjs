// Unit tests for the board paging rule (src/lib/boardPage.ts, #1438).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_PAGE_MAX, BOARD_PAGE_SIZE, boardPageParams, listIsPaged } from '../../src/lib/boardPage.ts';

const p = (qs) => new URLSearchParams(qs);

test('no params: every column, first page, default size', () => {
  assert.deepEqual(boardPageParams(p('view=board')), { stage: null, page: 1, perStage: BOARD_PAGE_SIZE });
});

test('a page beyond the first only inside one column', () => {
  assert.deepEqual(boardPageParams(p('page=3')), { stage: null, page: 1, perStage: BOARD_PAGE_SIZE });
  assert.deepEqual(boardPageParams(p('stage=HIRED_660&page=3')), { stage: 'HIRED_660', page: 3, perStage: BOARD_PAGE_SIZE });
});

test('pageSize is clamped; malformed numbers fall back', () => {
  assert.equal(boardPageParams(p('pageSize=5000')).perStage, BOARD_PAGE_MAX);
  assert.equal(boardPageParams(p('pageSize=abc')).perStage, BOARD_PAGE_SIZE);
  assert.equal(boardPageParams(p('stage=X&page=0')).page, 1);
});

test('a stage key outside the bounded alphabet is refused', () => {
  assert.deepEqual(boardPageParams(p('stage=' + encodeURIComponent("x' OR 1=1"))), { error: 'invalid_stage' });
  assert.deepEqual(boardPageParams(p('stage=' + 'a'.repeat(65))), { error: 'invalid_stage' });
  assert.deepEqual(boardPageParams(p('stage=')), { error: 'invalid_stage' });
});

test('pageSize alone pages the list — it is no longer silently ignored', () => {
  assert.equal(listIsPaged(p('pageSize=20')), true);
  assert.equal(listIsPaged(p('page=2')), true);
  assert.equal(listIsPaged(p('status=ACTIVE')), false);
});

test('recipients: one page of 50 by default; all=1 is bounded; the relation id is checked', async () => {
  const { recipientPageParams, RECIPIENT_PAGE_SIZE, RECIPIENT_ALL_MAX } = await import('../../src/lib/boardPage.ts');
  assert.deepEqual(recipientPageParams(p('page=3')), { all: false, page: 3, take: RECIPIENT_PAGE_SIZE, relationId: null });
  assert.deepEqual(recipientPageParams(p('all=1&page=9')), { all: true, page: 1, take: RECIPIENT_ALL_MAX, relationId: null });
  assert.equal(recipientPageParams(p('relation=abc_123')).relationId, 'abc_123');
  assert.equal(recipientPageParams(p('relation=' + encodeURIComponent('a b'))).relationId, null);
});
