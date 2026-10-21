// Unit tests for the job worker (#1673) — pure node, no browser, no database.
// Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// Every test drives `createWorker()` (src/lib/jobs/worker.ts) against the
// in-memory queue store, so it proves the LOOP: claim → run under a timeout →
// JobRun → SUCCEEDED / retry with backoff / DEAD_LETTER, the shutdown release
// and the start-time handler check. The guarded settle and heartbeat SQL are
// one `updateMany` each in src/lib/jobs/queueStore.ts.
import { test, expect } from '@playwright/test';
import { createMemoryQueueStore, enqueue, setQueueLogger, type JobRecord } from '@/lib/jobs/queue';
import { createJobRegistry, unhandledJobNames } from '@/lib/jobs/registry';
import { concurrencyFromEnv, createWorker, workerEnabled, type WorkerLogger } from '@/lib/jobs/worker';
import { backoffDelayMs, DEFAULT_BACKOFF, failureOutcome } from '@/lib/jobs/workerRule';

setQueueLogger({ warning: () => {} });

const T0 = new Date('2026-10-20T09:00:00Z');

function harness(opts: { random?: () => number; clock?: { now: Date } } = {}) {
  const store = createMemoryQueueStore();
  const registry = createJobRegistry();
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const logger: WorkerLogger = {
    info: (message, context) => logs.push({ level: 'info', message, context }),
    warning: (message, context) => logs.push({ level: 'warning', message, context }),
    error: (message, context) => logs.push({ level: 'error', message, context }),
  };
  const dead: { job: JobRecord; error: string }[] = [];
  const clock = opts.clock ?? { now: T0 };
  const worker = createWorker({
    store,
    registry,
    workerId: 'replica-a#1',
    concurrency: 2,
    now: () => clock.now,
    random: opts.random ?? (() => 0.5),
    logger,
    ownedElsewhere: ['email.send'],
    onDeadLetter: (job, error) => {
      dead.push({ job, error });
    },
  });
  // The production union types the payloads; these tests use their own names.
  const add = (name: string, payload: unknown = {}, more: { maxAttempts?: number; trigger?: 'manual' } = {}) =>
    enqueue(name as never, payload as never, { store, now: () => clock.now, ...more });
  return { store, registry, worker, logs, dead, clock, add };
}

test.describe('job worker', () => {
  test('a handler that resolves → SUCCEEDED, one ok JobRun with a duration', { tag: '@smoke' }, async () => {
    const h = harness();
    h.registry.register('test.ok', async (payload) => ({ seen: (payload as { n: number }).n }));
    const job = await h.add('test.ok', { n: 3 });

    const summary = await h.worker.tick();

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, deadLettered: 0 });
    const row = h.store.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
    expect(h.store.runs).toHaveLength(1);
    expect(h.store.runs[0]).toMatchObject({ jobId: job.id, attempt: 1, trigger: 'schedule' });
    expect(h.store.runs[0].patch).toMatchObject({ ok: true, summary: { seen: 3 } });
    expect(typeof h.store.runs[0].patch?.durationMs).toBe('number');
  });

  test("the JobRun carries the job's trigger — a manual re-run reads 'manual'", async () => {
    const h = harness();
    h.registry.register('test.ok', async () => {});
    await h.add('test.ok', {}, { trigger: 'manual' });
    await h.worker.tick();
    expect(h.store.runs[0].trigger).toBe('manual');
  });

  test('a handler that throws → PENDING, attempts+1, runAt pushed out exponentially', async () => {
    const clock = { now: T0 };
    const h = harness({ clock });
    h.registry.register('test.fail', async () => {
      throw new Error('ECONNREFUSED smtp');
    });
    const job = await h.add('test.fail', {}, { maxAttempts: 5 });

    const delays: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const summary = await h.worker.tick();
      expect(summary.retried).toBe(1);
      const row = h.store.jobs.find((j) => j.id === job.id)!;
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(i);
      expect(row.lastError).toBe('ECONNREFUSED smtp');
      delays.push(row.runAt.getTime() - clock.now.getTime());
      // Not due yet: a tick before runAt claims nothing.
      expect((await h.worker.tick()).claimed).toBe(0);
      clock.now = row.runAt;
    }
    // random() = 0.5 → jitter factor 1.0: exactly 30 s, 60 s, 120 s.
    expect(delays).toEqual([30_000, 60_000, 120_000]);
    expect(h.store.runs.map((r) => r.patch?.ok)).toEqual([false, false, false]);
  });

  test('after maxAttempts → DEAD_LETTER, lastError set, the dead-letter hook fires once', async () => {
    const clock = { now: T0 };
    const h = harness({ clock });
    h.registry.register('test.fail', async () => {
      throw new Error('still broken');
    });
    const job = await h.add('test.fail', {}, { maxAttempts: 2 });

    await h.worker.tick();
    clock.now = h.store.jobs[0].runAt;
    const summary = await h.worker.tick();

    expect(summary.deadLettered).toBe(1);
    const row = h.store.jobs.find((j) => j.id === job.id)!;
    expect(row).toMatchObject({ status: 'DEAD_LETTER', attempts: 2, lastError: 'still broken', lockedBy: null });
    expect(h.dead).toHaveLength(1);
    expect(h.dead[0].job.id).toBe(job.id);
    // Nothing claims it again.
    clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
    expect((await h.worker.tick()).claimed).toBe(0);
  });

  test('a handler that hangs past its timeout is failed and its signal aborted', async () => {
    const h = harness();
    let aborted = false;
    h.registry.register(
      'test.hang',
      (_p, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { timeoutMs: 50 }
    );
    const job = await h.add('test.hang');

    const summary = await h.worker.tick();

    expect(summary.retried).toBe(1);
    const row = h.store.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toMatch(/timed out after 50 ms/);
    expect(aborted).toBe(true);
    expect(h.worker.inFlight()).toBe(0);
  });

  test('shutdown stops claiming and releases a job still running, attempts untouched', async () => {
    const h = harness();
    let release!: () => void;
    h.registry.register('test.slow', (_p, ctx) => new Promise<void>((resolve, reject) => {
      release = resolve;
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const slow = await h.add('test.slow');
    const tick = h.worker.tick();
    // Let the claim land and the handler start.
    await expect.poll(() => h.worker.inFlight()).toBe(1);

    const result = await h.worker.shutdown(30);
    expect(result.released).toBe(1);
    await tick;
    const row = h.store.jobs.find((j) => j.id === slow.id)!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lockedBy: null });

    // After shutdown, nothing more is claimed.
    expect(h.worker.stopping()).toBe(true);
    expect((await h.worker.tick()).claimed).toBe(0);
    release();
  });

  test('shutdown lets an in-flight job finish inside the grace period', async () => {
    const h = harness();
    h.registry.register('test.quick', () => new Promise((r) => setTimeout(r, 400)));
    const job = await h.add('test.quick');
    const tick = h.worker.tick();
    await expect.poll(() => h.worker.inFlight()).toBe(1);

    expect((await h.worker.shutdown(2_000)).released).toBe(0);
    await tick;
    expect(h.store.jobs.find((j) => j.id === job.id)!.status).toBe('SUCCEEDED');
  });

  test('concurrency caps a tick; other kinds and unregistered names are never claimed', async () => {
    const h = harness();
    h.registry.register('test.ok', async () => {});
    for (let i = 0; i < 3; i++) await h.add('test.ok');
    await h.add('email.send');
    await h.add('nobody.handles.this');

    expect((await h.worker.tick()).claimed).toBe(2);
    expect((await h.worker.tick()).claimed).toBe(1);
    const others = h.store.jobs.filter((j) => j.name !== 'test.ok');
    expect(others.every((j) => j.status === 'PENDING' && j.attempts === 0)).toBe(true);
  });

  test('an unregistered job name is reported at start, the mail queue is not', async () => {
    const h = harness();
    h.registry.register('test.ok', async () => {});
    await h.add('test.ok');
    await h.add('email.send');
    await h.add('ghost.job');

    expect(await h.worker.checkHandlers()).toEqual(['ghost.job']);
    expect(h.logs.find((l) => l.level === 'error')).toMatchObject({
      message: 'job_worker.unregistered_jobs',
      context: { names: ['ghost.job'] },
    });
    expect(unhandledJobNames(['a', 'a', 'b'], h.registry, ['b'])).toEqual(['a']);
  });

  test('a settle lost to a newer owner is dropped, not applied', async () => {
    const h = harness();
    h.registry.register('test.ok', async () => {
      // Another replica reaped and re-claimed the row while this one worked.
      h.store.jobs[0].lockedBy = 'replica-b#2';
    });
    await h.add('test.ok');
    await h.worker.tick();
    expect(h.store.jobs[0]).toMatchObject({ status: 'RUNNING', lockedBy: 'replica-b#2' });
    expect(h.logs.some((l) => l.message === 'job_worker.settle_lost')).toBe(true);
  });

  test('a registry refuses a second handler for one name', () => {
    const r = createJobRegistry();
    r.register('x', async () => {});
    expect(() => r.register('x', async () => {})).toThrow(/already registered/);
  });
});

test.describe('worker rules', () => {
  test('backoff doubles from 30 s, caps at 1 h, and the jitter spreads ±25 %', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((a) => backoffDelayMs(a, DEFAULT_BACKOFF, mid))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffDelayMs(20, DEFAULT_BACKOFF, mid)).toBe(3_600_000);
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, () => 0)).toBe(22_500);
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, () => 0.999_999)).toBeLessThanOrEqual(37_500);
    // Capped retries still spread out.
    expect(backoffDelayMs(50, DEFAULT_BACKOFF, () => 0)).toBe(2_700_000);
  });

  test('the attempt that reaches maxAttempts dead-letters', () => {
    expect(failureOutcome(4, 5, T0, DEFAULT_BACKOFF, () => 0.5)).toMatchObject({ status: 'PENDING', attempts: 4 });
    expect(failureOutcome(5, 5, T0)).toEqual({ status: 'DEAD_LETTER', attempts: 5 });
  });

  test('env switches: JOBS_WORKER_ENABLED and JOBS_CONCURRENCY', () => {
    expect(workerEnabled(undefined)).toBe(true);
    expect(workerEnabled('0')).toBe(false);
    expect(workerEnabled(' off ')).toBe(false);
    expect(concurrencyFromEnv(undefined)).toBe(2);
    expect(concurrencyFromEnv('4')).toBe(4);
    expect(concurrencyFromEnv('999')).toBe(16);
    expect(concurrencyFromEnv('nope')).toBe(2);
  });
});
