// Unit tests for the scheduler (#1676) — pure node, no browser, no database.
// Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// Proves: the cron slot maths, that the registry and the source agree, that
// two schedulers on one database enqueue each slot once, the two catch-up
// modes, the first-sight baseline and the lease takeover after a holder dies.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { latestSlot, parseCron, matchesMinute } from '@/lib/jobs/cronSlot';
import { SCHEDULES, QUEUE_SCHEDULES, type QueueSchedule } from '@/lib/jobs/schedules';
import { createMemoryScheduleStateStore, schedulerTick, slotKey } from '@/lib/jobs/scheduler';
import { createMemoryLeaseStore, holdsLease, setLeaseLogger, SCHEDULER_LEASE } from '@/lib/jobs/lease';
import { createMemoryQueueStore, enqueue, setQueueLogger } from '@/lib/jobs/queue';
import { JOB_NAMES } from '@/lib/jobs/types';

setQueueLogger({ warning: () => {} });
setLeaseLogger({ info: () => {}, warning: () => {}, error: () => {} });

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// The containers run in UTC and slots are local time; pin the test to UTC.
const utc = (iso: string) => new Date(iso);

test.describe('cron slots', () => {
  test.skip(new Date().getTimezoneOffset() !== 0, 'slot maths is local time; the suite runs in UTC');

  test('parses the forms the registry uses and refuses the rest', () => {
    const m = parseCron('*/15 * * * *');
    expect([...m.sets[0]]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9 * * 1-5').sets[4]]).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 0 * * 7').sets[4].has(0)).toBe(true);
    expect(() => parseCron('0 9 * *')).toThrow();
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('0 9 * * MON')).toThrow();
  });

  test('latestSlot: the newest match at or before now, strictly after `after`', () => {
    const m = parseCron('45 6 * * *');
    expect(latestSlot(m, utc('2026-10-20T06:45:30Z'))?.toISOString()).toBe('2026-10-20T06:45:00.000Z');
    expect(latestSlot(m, utc('2026-10-20T06:44:59Z'))?.toISOString()).toBe('2026-10-19T06:45:00.000Z');
    expect(latestSlot(m, utc('2026-10-20T07:00:00Z'), utc('2026-10-20T06:45:00Z'))).toBeNull();
    expect(matchesMinute(parseCron('0 8 * * 1'), utc('2026-10-19T08:00:10Z'))).toBe(true); // a Monday
  });
});

test.describe('schedule registry', () => {
  test('keys are unique and no entry restricts both day fields', () => {
    const keys = SCHEDULES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SCHEDULES) {
      const m = parseCron(s.cron);
      expect(m.restrictsDom && m.restrictsDow, s.key).toBe(false);
      expect(s.why.length, s.key).toBeGreaterThan(10);
    }
  });

  test('every node-cron entry matches a scheduleLeased() call in its source, and vice versa', () => {
    const declared = SCHEDULES.filter((s) => s.carrier === 'node-cron');
    const bySource = new Map<string, string[]>();
    for (const s of declared) {
      if (s.carrier !== 'node-cron') continue;
      bySource.set(s.source, [...(bySource.get(s.source) ?? []), s.cron]);
    }
    for (const [source, crons] of bySource) {
      const found = [...read(source).matchAll(/scheduleLeased\('([^']+)'/g)].map((m) => m[1]);
      expect(found.sort(), source).toEqual([...crons].sort());
    }
    // And no scheduleLeased() call lives in a file the registry does not name.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk('src');
    for (const f of files) {
      const text = read(f);
      if (f !== 'src/lib/jobs/leasedCron.ts' && f !== 'src/lib/jobs/schedules.ts') {
        expect(/\bcron\.schedule\(/.test(text), `${f} calls cron.schedule() directly`).toBe(false);
        if (/scheduleLeased\('/.test(text)) expect(bySource.has(f), f).toBe(true);
      }
    }
  });

  test('every queue entry names a known job with a registered handler', () => {
    const handlers = read('src/jobs/index.ts');
    for (const s of QUEUE_SCHEDULES) {
      expect(JOB_NAMES).toContain(s.job);
      expect(handlers).toContain(`registerJob('${s.job}'`);
    }
  });
});

// ── The tick ────────────────────────────────────────────────────────────────

const DAILY: QueueSchedule = {
  carrier: 'queue',
  key: 'jobs.deadLetterAlert',
  cron: '45 6 * * *',
  job: 'jobs.deadLetterAlert',
  payload: {},
  catchUp: 'latest',
  why: 'test',
};

function world() {
  const queue = createMemoryQueueStore();
  const leases = createMemoryLeaseStore();
  const states = createMemoryScheduleStateStore();
  const ticker = (holder: string) => (now: Date, schedules: QueueSchedule[] = [DAILY]) =>
    schedulerTick({
      now,
      schedules,
      holdsLease: () => holdsLease(SCHEDULER_LEASE, holder, 90_000, { store: leases, now: () => now.getTime() }),
      states,
      enqueue: (s, _slot, idempotencyKey) => enqueue(s.job, s.payload as never, { store: queue, idempotencyKey, trigger: 'schedule', now: () => now }),
    });
  return { queue, leases, states, ticker };
}

test.describe('scheduler tick', () => {
  test.skip(new Date().getTimezoneOffset() !== 0, 'slot maths is local time; the suite runs in UTC');

  test('two schedulers on one database enqueue each slot exactly once', { tag: '@smoke' }, async () => {
    const w = world();
    const a = w.ticker('replica-a#1');
    const b = w.ticker('replica-b#2');
    await a(utc('2026-10-19T06:00:00Z')); // first sight: baseline
    for (const iso of ['2026-10-20T06:45:05Z', '2026-10-20T06:45:20Z', '2026-10-20T06:45:40Z', '2026-10-20T06:46:10Z']) {
      await Promise.all([a(utc(iso)), b(utc(iso))]);
    }
    expect(w.queue.jobs.map((j) => j.idempotencyKey)).toEqual([slotKey('jobs.deadLetterAlert', utc('2026-10-20T06:45:00Z'))]);
    expect(w.queue.jobs[0].trigger).toBe('schedule');
  });

  test('a non-holder does nothing at all — no enqueue, no state', async () => {
    const w = world();
    await w.ticker('replica-a#1')(utc('2026-10-20T06:45:05Z'));
    const r = await w.ticker('replica-b#2')(utc('2026-10-20T06:45:20Z'));
    expect(r).toEqual({ leader: false, enqueued: 0, skippedMissed: 0, baselined: 0, failed: 0 });
  });

  test("catchUp 'latest': six missed days enqueue ONE job, for the most recent slot", async () => {
    const w = world();
    const t = w.ticker('replica-a#1');
    await t(utc('2026-10-10T06:45:10Z'));
    expect(w.queue.jobs).toHaveLength(1);
    const r = await t(utc('2026-10-16T09:04:00Z'));
    expect(r.enqueued).toBe(1);
    expect(w.queue.jobs.map((j) => j.idempotencyKey)).toEqual([
      'jobs.deadLetterAlert:2026-10-10T06:45:00.000Z',
      'jobs.deadLetterAlert:2026-10-16T06:45:00.000Z',
    ]);
  });

  test("catchUp 'none': a missed slot is skipped, an on-time one is enqueued", async () => {
    const w = world();
    const t = w.ticker('replica-a#1');
    const none: QueueSchedule = { ...DAILY, key: 'k.none', catchUp: 'none' };
    await t(utc('2026-10-10T06:45:10Z'), [none]);
    expect((await t(utc('2026-10-12T10:00:00Z'), [none])).skippedMissed).toBe(1);
    expect(w.queue.jobs).toHaveLength(1);
    expect((await t(utc('2026-10-13T06:46:30Z'), [none])).enqueued).toBe(1);
    expect(w.queue.jobs).toHaveLength(2);
  });

  test('first sight of a schedule baselines a stale slot instead of firing it on deploy', async () => {
    const w = world();
    const r = await w.ticker('replica-a#1')(utc('2026-10-20T12:00:00Z'));
    expect(r).toMatchObject({ leader: true, enqueued: 0, baselined: 1 });
    expect(w.states.rows.get('jobs.deadLetterAlert')?.toISOString()).toBe('2026-10-20T06:45:00.000Z');
  });

  test('a dead holder loses the lease within one TTL and the other scheduler takes over', async () => {
    const w = world();
    const a = w.ticker('replica-a#1');
    const b = w.ticker('replica-b#2');
    expect((await a(utc('2026-10-20T06:00:00Z'))).leader).toBe(true);
    expect((await b(utc('2026-10-20T06:00:30Z'))).leader).toBe(false);
    // a dies at 06:00:00; its lease runs to 06:01:30.
    expect((await b(utc('2026-10-20T06:01:20Z'))).leader).toBe(false);
    expect((await b(utc('2026-10-20T06:01:31Z'))).leader).toBe(true);
    await b(utc('2026-10-20T06:45:10Z'));
    expect(w.queue.jobs.map((j) => j.idempotencyKey)).toEqual(['jobs.deadLetterAlert:2026-10-20T06:45:00.000Z']);
  });

  test('a ScheduleState write never moves a schedule backwards', async () => {
    const s = createMemoryScheduleStateStore();
    expect(await s.advance('k', undefined, utc('2026-10-20T06:45:00Z'))).toBe(true);
    expect(await s.advance('k', undefined, utc('2026-10-19T06:45:00Z'))).toBe(false);
    expect(await s.advance('k', utc('2026-10-18T06:45:00Z'), utc('2026-10-21T06:45:00Z'))).toBe(false);
    expect(s.rows.get('k')?.toISOString()).toBe('2026-10-20T06:45:00.000Z');
  });
});
