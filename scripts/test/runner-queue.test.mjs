// The Runner Watchdog's "is the runner stuck?" rule (scripts/runner-queue.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnerStuckVerdict } from '../runner-queue.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const base = { runnerName: 'box', label: 'self-hosted', now: NOW, stuckAfterMin: 30 };

test('jobs waiting past the threshold with nothing running → stuck', () => {
  const v = runnerStuckVerdict({
    ...base,
    queuedJobs: [{ labels: ['self-hosted'], created_at: ago(95) }, { labels: ['self-hosted'], created_at: ago(5) }],
    runningJobs: [],
  });
  assert.equal(v.stuck, true);
  assert.match(v.reason, /2 job\(s\).*95 min/);
});

test('a runner executing a job is never stuck, however long the queue waits', () => {
  const v = runnerStuckVerdict({
    ...base,
    queuedJobs: [{ labels: ['self-hosted'], created_at: ago(600) }],
    runningJobs: [{ runner_name: 'box' }],
  });
  assert.equal(v.stuck, false);
});

test('a job running on ANOTHER runner does not count as this one being busy', () => {
  const v = runnerStuckVerdict({
    ...base,
    queuedJobs: [{ labels: ['self-hosted'], created_at: ago(45) }],
    runningJobs: [{ runner_name: 'GitHub Actions 1000028790' }, { runner_name: null }],
  });
  assert.equal(v.stuck, true);
});

test('a short wait is just a queue', () => {
  const v = runnerStuckVerdict({ ...base, queuedJobs: [{ labels: ['self-hosted'], created_at: ago(29) }], runningJobs: [] });
  assert.equal(v.stuck, false);
});

test('only jobs for the runner label count; hosted jobs waiting do not', () => {
  const v = runnerStuckVerdict({
    ...base,
    queuedJobs: [{ labels: ['ubuntu-latest'], created_at: ago(9000) }, { created_at: ago(9000) }],
    runningJobs: [],
  });
  assert.equal(v.stuck, false);
  assert.match(v.reason, /no job is waiting/);
});

test('a custom runner label is matched exactly', () => {
  const queuedJobs = [{ labels: ['interncrm'], created_at: ago(60) }];
  assert.equal(runnerStuckVerdict({ ...base, label: 'interncrm', queuedJobs, runningJobs: [] }).stuck, true);
  assert.equal(runnerStuckVerdict({ ...base, label: 'self-hosted', queuedJobs, runningJobs: [] }).stuck, false);
});

test('an unparseable timestamp never triggers a restart', () => {
  const v = runnerStuckVerdict({ ...base, queuedJobs: [{ labels: ['self-hosted'], created_at: 'soon' }], runningJobs: [] });
  assert.equal(v.stuck, false);
});
