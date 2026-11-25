// Unit tests for the "My feedback" summary and filter (#3929, src/lib/myFeedbackFilter.ts).
// What must never drift: WONT_FIX is not "done", and a status this page does not know is "open".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackOutcome, myFeedbackProgress, filterMyFeedback, isMyFeedbackFilter } from '../../src/lib/myFeedbackFilter.ts';

test('five statuses fold into three outcomes; an unknown one waits', () => {
  assert.equal(feedbackOutcome('RESOLVED'), 'done');
  assert.equal(feedbackOutcome('WONT_FIX'), 'wontFix');
  for (const s of ['NEW', 'TRIAGED', 'IN_PROGRESS', 'SOMETHING_NEW']) assert.equal(feedbackOutcome(s), 'open');
});

test('the summary counts each outcome once; "will not be changed" is never "completed"', () => {
  const rows = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'RESOLVED', 'WONT_FIX'].map((status) => ({ status }));
  assert.deepEqual(myFeedbackProgress(rows), { total: 6, done: 2, open: 3, wontFix: 1 });
  assert.deepEqual(myFeedbackProgress([]), { total: 0, done: 0, open: 0, wontFix: 0 });
});

test('the filter keeps the order and only the outcome asked for', () => {
  const rows = [{ id: 'a', status: 'NEW' }, { id: 'b', status: 'RESOLVED' }, { id: 'c', status: 'IN_PROGRESS' }, { id: 'd', status: 'WONT_FIX' }];
  assert.deepEqual(filterMyFeedback(rows, 'open').map((r) => r.id), ['a', 'c']);
  assert.deepEqual(filterMyFeedback(rows, 'done').map((r) => r.id), ['b']);
  assert.deepEqual(filterMyFeedback(rows, 'wontFix').map((r) => r.id), ['d']);
  assert.deepEqual(filterMyFeedback(rows, 'all').map((r) => r.id), ['a', 'b', 'c', 'd']);
  assert.equal(isMyFeedbackFilter('done'), true);
  assert.equal(isMyFeedbackFilter('RESOLVED'), false);
});
