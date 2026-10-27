// Unit tests for the operations console's verdicts (#1607) — pure node, no
// browser, no database. Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// Proves: a schedule that never ran is an ALARM rather than an empty cell, a
// stalled scheduler and a stalled worker read apart, an organization-scoped
// operator is never alarmed by runs it cannot see, and every schedule in the
// registry has a next slot.
import { test, expect } from '@playwright/test';
import { nextSlot, scheduleAlarms, SCHEDULER_GRACE_MS, WORKER_GRACE_MS } from '@/lib/jobs/operationsRule';
import { QUEUE_SCHEDULES } from '@/lib/jobs/schedules';
import { manualKeyForJob, manualJobFor } from '@/lib/jobs/manualJobs';

const at = (iso: string) => new Date(iso);
const daily = '45 6 * * *';

test.describe('operations rule', { tag: '@smoke' }, () => {
  test.skip(new Date().getTimezoneOffset() !== 0, 'slot maths is local time; the suite runs in UTC');

  test('a schedule the scheduler never enqueued is an alarm', () => {
    const now = at('2026-10-20T12:00:00Z');
    expect(scheduleAlarms({ cron: daily, lastEnqueuedSlot: null, stateMissing: true, lastRun: null, runsVisible: true }, now)).toEqual([
      'never_enqueued',
    ]);
    // Even for an operator who cannot see the runs: the schedule state is not tenant data.
    expect(scheduleAlarms({ cron: daily, lastEnqueuedSlot: null, stateMissing: true, lastRun: null, runsVisible: false }, now)).toEqual([
      'never_enqueued',
    ]);
  });

  test('on schedule: enqueued the latest slot, ran after it, succeeded', () => {
    const now = at('2026-10-20T12:00:00Z');
    const slot = at('2026-10-20T06:45:00Z');
    const run = { startedAt: at('2026-10-20T06:45:20Z'), finishedAt: at('2026-10-20T06:45:21Z'), ok: true };
    expect(scheduleAlarms({ cron: daily, lastEnqueuedSlot: slot, stateMissing: false, lastRun: run, runsVisible: true }, now)).toEqual([]);
  });

  test('a missed slot past the grace is the scheduler; inside the grace it is not', () => {
    const slot = at('2026-10-19T06:45:00Z');
    const run = { startedAt: at('2026-10-19T06:45:20Z'), finishedAt: at('2026-10-19T06:45:21Z'), ok: true };
    const facts = { cron: daily, lastEnqueuedSlot: slot, stateMissing: false, lastRun: run, runsVisible: true };
    expect(scheduleAlarms(facts, new Date(at('2026-10-20T06:45:00Z').getTime() + SCHEDULER_GRACE_MS - 1000))).toEqual([]);
    expect(scheduleAlarms(facts, at('2026-10-20T12:00:00Z'))).toEqual(['scheduler_behind']);
  });

  test('an enqueued slot no run has picked up is the worker — only when the runs are visible', () => {
    const slot = at('2026-10-20T06:45:00Z');
    const old = { startedAt: at('2026-10-19T06:45:20Z'), finishedAt: at('2026-10-19T06:45:21Z'), ok: true };
    const late = new Date(slot.getTime() + WORKER_GRACE_MS + 60_000);
    const facts = { cron: daily, lastEnqueuedSlot: slot, stateMissing: false, lastRun: old, runsVisible: true };
    expect(scheduleAlarms(facts, late)).toEqual(['worker_behind']);
    expect(scheduleAlarms({ ...facts, lastRun: null }, late)).toEqual(['worker_behind']);
    expect(scheduleAlarms({ ...facts, runsVisible: false }, late)).toEqual([]);
    expect(scheduleAlarms(facts, new Date(slot.getTime() + 60_000))).toEqual([]);
  });

  test('a failed last run alarms; a run still in flight does not', () => {
    const now = at('2026-10-20T12:00:00Z');
    const slot = at('2026-10-20T06:45:00Z');
    const base = { cron: daily, lastEnqueuedSlot: slot, stateMissing: false, runsVisible: false };
    expect(scheduleAlarms({ ...base, lastRun: { startedAt: at('2026-10-20T06:45:20Z'), finishedAt: at('2026-10-20T06:45:30Z'), ok: false } }, now)).toEqual([
      'last_run_failed',
    ]);
    expect(scheduleAlarms({ ...base, lastRun: { startedAt: at('2026-10-20T06:45:20Z'), finishedAt: null, ok: false } }, now)).toEqual([]);
  });

  test('nextSlot is strictly after now', () => {
    expect(nextSlot(daily, at('2026-10-20T06:45:00Z'))?.toISOString()).toBe('2026-10-21T06:45:00.000Z');
    expect(nextSlot(daily, at('2026-10-20T06:44:59Z'))?.toISOString()).toBe('2026-10-20T06:45:00.000Z');
    expect(nextSlot('*/5 * * * *', at('2026-10-20T06:46:10Z'))?.toISOString()).toBe('2026-10-20T06:50:00.000Z');
  });

  test('every registered schedule has a next slot', () => {
    for (const s of QUEUE_SCHEDULES) expect(nextSlot(s.cron, at('2026-10-20T12:00:00Z')), s.key).not.toBeNull();
  });

  test('manualKeyForJob is the inverse of manualJobFor', () => {
    for (const s of QUEUE_SCHEDULES) {
      const m = manualKeyForJob(s.job);
      if (!m) continue;
      expect(manualJobFor(m.key, { orgId: 'org-1' })?.name, s.key).toBe(s.job);
    }
  });
});
