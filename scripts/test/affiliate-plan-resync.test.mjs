// Unit tests for the plan-change re-evaluation's state (src/lib/affiliatePlanResyncRule.ts,
// docs/affiliate-module.md, #3170). Partner ids are synthetic.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESYNC_END,
  RETRY_CAP,
  beginAttempt,
  finishAttempt,
  parseResyncState,
  queuedResync,
  recordPassBatch,
  recordRetry,
  resyncInFlight,
} from '../../src/lib/affiliatePlanResyncRule.ts';

const NOW = new Date('2026-10-29T10:00:00Z');
const ok = (id, drift = 0) => ({ id, ok: true, drift });
const bad = (id) => ({ id, ok: false, drift: 0 });

test('a clean run: one pass, every partner counted, DONE', () => {
  let { state, mode } = beginAttempt(queuedResync(3, NOW), NOW);
  assert.equal(mode, 'pass');
  assert.equal(state.status, 'RUNNING');
  state = recordPassBatch(state, [ok('a'), ok('b', 2)]);
  assert.equal(state.cursor, 'b');
  state = recordPassBatch(state, [ok('c')]);
  state = finishAttempt(state, 1, 5, NOW);
  assert.deepEqual([state.status, state.done, state.failed, state.drift, state.cursor], ['DONE', 3, 0, 2, RESYNC_END]);
  assert.equal(resyncInFlight(state), false);
});

test('a rerun after a crash resumes after the cursor, not from the start', () => {
  let { state } = beginAttempt(queuedResync(1, NOW), NOW);
  state = recordPassBatch(state, [ok('a'), ok('b')]);
  // The process dies here; the stored state is the checkpoint.
  const stored = parseResyncState(JSON.parse(JSON.stringify(state)));
  const again = beginAttempt(stored, NOW);
  assert.equal(again.mode, 'pass');
  assert.equal(again.state.cursor, 'b');
  assert.equal(again.state.done, 2);
});

test('failures are retried by the next attempt, and only they', () => {
  let { state } = beginAttempt(queuedResync(1, NOW), NOW);
  state = recordPassBatch(state, [ok('a'), bad('b'), bad('c')]);
  state = finishAttempt(state, 1, 3, NOW);
  assert.deepEqual([state.status, state.failed, state.retry], ['RETRYING', 2, ['b', 'c']]);
  assert.equal(resyncInFlight(state), true);

  const next = beginAttempt(state, NOW);
  assert.equal(next.mode, 'retry');
  state = recordRetry(next.state, [ok('b', 1), bad('c')]);
  state = finishAttempt(state, 2, 3, NOW);
  assert.deepEqual([state.status, state.done, state.failed, state.drift, state.retry], ['RETRYING', 2, 1, 1, ['c']]);

  state = recordRetry(beginAttempt(state, NOW).state, [bad('c')]);
  state = finishAttempt(state, 3, 3, NOW);
  assert.deepEqual([state.status, state.failed], ['INCOMPLETE', 1]);
  assert.equal(state.finishedAt, NOW.toISOString());
});

test('past the retry cap the next attempt walks every partner again, counting afresh', () => {
  let { state } = beginAttempt(queuedResync(1, NOW), NOW);
  const ids = Array.from({ length: RETRY_CAP + 2 }, (_, i) => `p${String(i).padStart(4, '0')}`);
  state = recordPassBatch(state, [ok('a'), ...ids.map(bad)]);
  assert.equal(state.retry.length, RETRY_CAP);
  assert.equal(state.overflow, true);
  assert.equal(state.failed, RETRY_CAP + 2);
  state = finishAttempt(state, 1, 5, NOW);
  const next = beginAttempt(state, NOW);
  assert.equal(next.mode, 'pass');
  assert.deepEqual([next.state.cursor, next.state.done, next.state.failed, next.state.retry.length, next.state.overflow], [null, 0, 0, 0, false]);
});

test('a stored state is read defensively', () => {
  assert.equal(parseResyncState(null), null);
  assert.equal(parseResyncState({ v: 'x', status: 'DONE' }), null);
  assert.equal(parseResyncState({ v: 1, status: 'WHATEVER' }), null);
  const s = parseResyncState({ v: 2, status: 'RUNNING', done: -3, retry: ['a', 7], startedAt: 'nope' });
  assert.deepEqual([s.done, s.retry, s.startedAt], [0, ['a'], null]);
});
