// Unit tests for the job queue engine (#1671) — pure node, no browser, no
// database. Playwright resolves the tsconfig `@/` paths, which `node --test`
// cannot; run with BASE_URL=http://localhost:9 to skip the webServer.
//
// WHAT IS AND IS NOT PROVED HERE. Every test below drives `src/lib/jobs/queue.ts`
// against the in-memory store that module exports. That store is a MODEL of the
// engine: its `claimDue()` locks its candidate rows synchronously and skips rows
// another in-flight claim already holds, which is `FOR UPDATE SKIP LOCKED` in
// one sentence. So these tests prove the RULES — that a collision returns the
// existing row, that two interleaved claims cannot both take one job, that a
// reap leaves `attempts` alone, that the ledger can never fail a run.
//
// They do NOT prove the SQL. The statement in `src/lib/jobs/queueStore.ts` is
// only exercised against a real MySQL 8, and a contention test against a live
// engine needs two connections and a database this suite does not stand up. The
// last test in this file therefore reads the SQL as text and asserts the four
// things a typo could quietly remove — which is the part a model store cannot
// catch and the part that fails at 03:00 when it is wrong.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  claim,
  createMemoryQueueStore,
  enqueue,
  pruneJobRuns,
  reapExpiredLeases,
  recordRun,
  sanitizeSummary,
  setQueueLogger,
  type MemoryQueueStore,
  type QueueStore,
} from '@/lib/jobs/queue';
import { JOB_NAME_MAX_LENGTH, JOB_TRIGGERS, isJobName, isJobTrigger } from '@/lib/jobs/types';

// The rules module logs ledger failures. Silence it for the tests that cause
// them on purpose, and keep what it said so the "swallowed" path can be shown
// to be reported rather than hidden.
const warnings: { message: string; context?: Record<string, unknown> }[] = [];
setQueueLogger({ warning: (message, context) => warnings.push({ message, context }) });
test.beforeEach(() => {
  warnings.length = 0;
});

const at = (iso: string) => new Date(iso);
const clock = (iso: string) => () => at(iso);

// ── enqueue ─────────────────────────────────────────────────────────────────

test.describe('enqueue', () => {
  test('the same idempotencyKey produces one row and returns it both times', async () => {
    const store = createMemoryQueueStore();
    const opts = { store, idempotencyKey: 'prune:2026-09-14', now: clock('2026-09-14T03:00:00Z') };

    const first = await enqueue('jobs.pruneRuns', { retentionDays: 90 }, opts);
    const second = await enqueue('jobs.pruneRuns', { retentionDays: 90 }, opts);

    expect(store.jobs).toHaveLength(1);
    expect(second.id).toBe(first.id);
    // The SECOND call's payload is discarded, not merged: the row that already
    // exists is the one that will run, and pretending otherwise would make the
    // winner depend on call order.
    const third = await enqueue('jobs.pruneRuns', { retentionDays: 1 }, opts);
    expect(third.id).toBe(first.id);
    expect(store.jobs).toHaveLength(1);
    expect((store.jobs[0].payload as { retentionDays: number }).retentionDays).toBe(90);
  });

  test('two different keys are two rows; no key never de-duplicates', async () => {
    const store = createMemoryQueueStore();
    await enqueue('jobs.pruneRuns', {}, { store, idempotencyKey: 'a' });
    await enqueue('jobs.pruneRuns', {}, { store, idempotencyKey: 'b' });
    await enqueue('jobs.pruneRuns', {}, { store });
    await enqueue('jobs.pruneRuns', {}, { store });
    expect(store.jobs).toHaveLength(4);
  });

  test('an insert failure that is NOT a key collision is rethrown, not reported as enqueued', async () => {
    const boom = new Error('connection lost');
    const store: QueueStore = {
      ...createMemoryQueueStore(),
      insertJob: async () => {
        throw boom;
      },
      // The key exists but no row was written — the "look it up" branch finds
      // nothing and must surface the ORIGINAL cause, not a fabricated success.
      findJobByIdempotencyKey: async () => null,
    };
    await expect(enqueue('jobs.pruneRuns', {}, { store, idempotencyKey: 'k' })).rejects.toThrow(
      'connection lost'
    );
    await expect(enqueue('jobs.pruneRuns', {}, { store })).rejects.toThrow('connection lost');
  });

  test('defaults: PENDING, due now, priority 0, five attempts, no org', async () => {
    const store = createMemoryQueueStore();
    const row = await enqueue('jobs.deadLetterAlert', {}, { store, now: clock('2026-09-14T06:00:00Z') });
    expect(row.status).toBe('PENDING');
    expect(row.runAt.toISOString()).toBe('2026-09-14T06:00:00.000Z');
    expect(row.priority).toBe(0);
    expect(row.maxAttempts).toBe(5);
    expect(row.orgId).toBeNull();
    expect(row.attempts).toBe(0);
  });

  test('every job name fits the VarChar(64) the column declares', async () => {
    for (const name of ['jobs.pruneRuns', 'jobs.deadLetterAlert']) {
      expect(isJobName(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(JOB_NAME_MAX_LENGTH);
    }
    expect(isJobName('jobs.somethingNobodyRegistered')).toBe(false);
  });
});

// ── claim ───────────────────────────────────────────────────────────────────

test.describe('claim', () => {
  test('two interleaved claims hand one job to exactly one caller', async () => {
    // The interleaving is the point. `pause` suspends the first claim AFTER it
    // has locked its rows and BEFORE it updates them — precisely the window in
    // which a second worker would otherwise read the same PENDING row. With
    // SKIP LOCKED the second claim steps over it and comes back empty; without
    // it, both callers would get the job and it would run twice.
    let release: () => void = () => {};
    let paused = false;
    const store = createMemoryQueueStore({
      pause: async () => {
        if (paused) return;
        paused = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    await enqueue('jobs.pruneRuns', {}, { store, now: clock('2026-09-14T03:00:00Z') });

    const a = claim('worker-a', { store, now: clock('2026-09-14T03:00:01Z') });
    // Let the first claim reach its pause before the second one starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = await claim('worker-b', { store, now: clock('2026-09-14T03:00:01Z') });
    release();
    const claimedA = await a;

    expect(claimedA).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(claimedA[0].status).toBe('RUNNING');
    expect(claimedA[0].lockedBy).toBe('worker-a');
    expect(store.jobs[0].lockedBy).toBe('worker-a');
  });

  test('claims in priority DESC, runAt ASC order and never past the limit', async () => {
    const store = createMemoryQueueStore();
    const base = '2026-09-14T03:00:00Z';
    await enqueue('jobs.pruneRuns', {}, { store, runAt: at('2026-09-14T02:00:00Z'), priority: 0 });
    await enqueue('jobs.deadLetterAlert', {}, { store, runAt: at('2026-09-14T02:30:00Z'), priority: 9 });
    await enqueue('jobs.pruneRuns', {}, { store, runAt: at('2026-09-14T01:00:00Z'), priority: 0 });

    const claimed = await claim('worker', { store, limit: 2, now: clock(base) });
    expect(claimed.map((j) => j.name)).toEqual(['jobs.deadLetterAlert', 'jobs.pruneRuns']);
    // Of the two priority-0 rows the OLDER one went first.
    expect(claimed[1].runAt.toISOString()).toBe('2026-09-14T01:00:00.000Z');
  });

  test('a job whose runAt is in the future is not due and is not claimed', async () => {
    const store = createMemoryQueueStore();
    await enqueue('jobs.pruneRuns', {}, { store, runAt: at('2026-09-14T04:00:00Z') });
    expect(await claim('worker', { store, now: clock('2026-09-14T03:59:59Z') })).toHaveLength(0);
    expect(await claim('worker', { store, now: clock('2026-09-14T04:00:00Z') })).toHaveLength(1);
  });

  test('an empty worker id is refused: a lease has to name a holder', async () => {
    const store = createMemoryQueueStore();
    await expect(claim('', { store })).rejects.toThrow(/worker id/i);
  });
});

// ── reapExpiredLeases ───────────────────────────────────────────────────────

test.describe('reapExpiredLeases', () => {
  test('a stale RUNNING job returns to PENDING with attempts untouched', async () => {
    const store = createMemoryQueueStore();
    await enqueue('jobs.pruneRuns', {}, { store, now: clock('2026-09-14T03:00:00Z') });
    await claim('dead-worker', { store, now: clock('2026-09-14T03:00:00Z') });
    // The worker did attempt this job once before its container was killed.
    store.jobs[0].attempts = 2;

    // Four minutes in, with a five-minute lease, the claim is still live.
    expect(await reapExpiredLeases(5 * 60_000, { store, now: clock('2026-09-14T03:04:00Z') })).toBe(0);
    expect(store.jobs[0].status).toBe('RUNNING');

    // Six minutes in it is not.
    expect(await reapExpiredLeases(5 * 60_000, { store, now: clock('2026-09-14T03:06:00Z') })).toBe(1);
    expect(store.jobs[0].status).toBe('PENDING');
    expect(store.jobs[0].lockedAt).toBeNull();
    expect(store.jobs[0].lockedBy).toBeNull();
    // THE POINT: a lease that expired is not an attempt that failed. Charging
    // it a retry would let a queue that keeps losing containers dead-letter
    // work that was never actually tried.
    expect(store.jobs[0].attempts).toBe(2);
  });

  test('a reaped job is claimable again, by a different worker', async () => {
    const store = createMemoryQueueStore();
    await enqueue('jobs.pruneRuns', {}, { store, now: clock('2026-09-14T03:00:00Z') });
    await claim('dead-worker', { store, now: clock('2026-09-14T03:00:00Z') });
    await reapExpiredLeases(60_000, { store, now: clock('2026-09-14T03:10:00Z') });

    const again = await claim('live-worker', { store, now: clock('2026-09-14T03:10:01Z') });
    expect(again).toHaveLength(1);
    expect(again[0].lockedBy).toBe('live-worker');
  });

  test('PENDING and finished jobs are never touched', async () => {
    const store = createMemoryQueueStore();
    await enqueue('jobs.pruneRuns', {}, { store, now: clock('2026-09-14T03:00:00Z') });
    await enqueue('jobs.deadLetterAlert', {}, { store, now: clock('2026-09-14T03:00:00Z') });
    store.jobs[1].status = 'DEAD_LETTER';
    expect(await reapExpiredLeases(1_000, { store, now: clock('2026-09-15T03:00:00Z') })).toBe(0);
    expect(store.jobs[0].status).toBe('PENDING');
    expect(store.jobs[1].status).toBe('DEAD_LETTER');
  });
});

// ── recordRun ───────────────────────────────────────────────────────────────

function ledger(store: MemoryQueueStore) {
  return store.runs[0];
}

test.describe('recordRun', () => {
  test('a successful run is opened before the handler and stamped after', async () => {
    const store = createMemoryQueueStore();
    let sawRowWhileRunning = 0;

    const ticks = ['2026-09-14T03:00:00Z', '2026-09-14T03:00:02Z'];
    let tick = 0;
    const summary = await recordRun(
      'job_1',
      1,
      'schedule',
      async () => {
        // The ledger row exists WHILE the handler runs — that is what makes a
        // job that wedges its container visible at all.
        sawRowWhileRunning = store.runs.length;
        return { mentorsNudged: 3, mailsSent: 3 };
      },
      { store, now: () => at(ticks[Math.min(tick++, ticks.length - 1)]) }
    );

    expect(sawRowWhileRunning).toBe(1);
    expect(summary).toEqual({ mentorsNudged: 3, mailsSent: 3 });
    const row = ledger(store);
    expect(row.attempt).toBe(1);
    expect(row.trigger).toBe('schedule');
    expect(row.patch).not.toBeNull();
    expect(row.patch!.ok).toBe(true);
    expect(row.patch!.error).toBeNull();
    expect(row.patch!.durationMs).toBe(2000);
    expect(row.patch!.summary).toEqual({ mentorsNudged: 3, mailsSent: 3 });
  });

  test("the handler's throw is recorded AND rethrown", async () => {
    const store = createMemoryQueueStore();
    await expect(
      recordRun('job_1', 3, 'manual', async () => {
        throw new Error('SMTP 550 mailbox unavailable');
      }, { store })
    ).rejects.toThrow('SMTP 550 mailbox unavailable');

    const row = ledger(store);
    expect(row.patch!.ok).toBe(false);
    expect(row.patch!.error).toBe('SMTP 550 mailbox unavailable');
    expect(row.patch!.summary).toBeNull();
    // Rethrown, because the worker (#1673) decides retry-or-dead-letter from it
    // and the error tracker (#1600) has to see it.
  });

  test('a ledger that cannot be written never fails the run', async () => {
    // Both halves of the ledger are broken: the opening insert and the
    // finishing stamp. The job must still run and still return its result.
    const broken: QueueStore = {
      ...createMemoryQueueStore(),
      insertRun: async () => {
        throw new Error('JobRun table is gone');
      },
      finishRun: async () => {
        throw new Error('unreachable');
      },
    };

    let ran = false;
    const summary = await recordRun(
      'job_1',
      1,
      'boot',
      async () => {
        ran = true;
        return { swept: 41 };
      },
      { store: broken }
    );

    expect(ran).toBe(true);
    expect(summary).toEqual({ swept: 41 });
    // Swallowed, but not hidden: the failure is invisible everywhere else by
    // construction, so the log line is the only trace it leaves.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('JobRun');
    expect(warnings[0].context?.error).toBe('JobRun table is gone');
  });

  test('a failing finishing stamp neither hides the result nor swallows the handler throw', async () => {
    const base = createMemoryQueueStore();
    const broken: QueueStore = {
      ...base,
      finishRun: async () => {
        throw new Error('write timeout');
      },
    };

    expect(await recordRun('job_1', 1, 'schedule', async () => ({ n: 1 }), { store: broken })).toEqual({
      n: 1,
    });
    await expect(
      recordRun('job_1', 2, 'schedule', async () => {
        throw new Error('handler blew up');
      }, { store: broken })
    ).rejects.toThrow('handler blew up');
    expect(warnings).toHaveLength(2);
  });

  test('a handler that returns nothing records a null summary, not an empty object', async () => {
    const store = createMemoryQueueStore();
    expect(await recordRun('job_1', 1, 'schedule', async () => {}, { store })).toBeNull();
    expect(ledger(store).patch!.summary).toBeNull();
    expect(ledger(store).patch!.ok).toBe(true);
  });

  test('every trigger value the type allows is a value the VarChar(16) column takes', () => {
    for (const trigger of JOB_TRIGGERS) {
      expect(isJobTrigger(trigger)).toBe(true);
      expect(trigger.length).toBeLessThanOrEqual(16);
    }
    expect(isJobTrigger('cron')).toBe(false);
    expect(isJobTrigger(null)).toBe(false);
  });
});

// ── summary is counters only ────────────────────────────────────────────────

test.describe('sanitizeSummary', () => {
  test('drops everything that is not a finite number', () => {
    // The type already makes this unrepresentable in TypeScript; this is the
    // runtime half, because a handler can be reached from JavaScript and the
    // admin surfaces render the summary more or less verbatim.
    expect(
      sanitizeSummary({
        sent: 4,
        // None of these may survive: an address, a name, a message body.
        to: 'mentee@example.com',
        mentor: 'Ayşe Yılmaz',
        body: 'Merhaba, hâlâ ilgileniyor musun?',
        nested: { count: 9 },
        list: [1, 2, 3],
        nan: Number.NaN,
        infinite: Number.POSITIVE_INFINITY,
        nothing: null,
        flag: true,
      })
    ).toEqual({ sent: 4 });
  });

  test('null, arrays and primitives all collapse to null', () => {
    expect(sanitizeSummary(null)).toBeNull();
    expect(sanitizeSummary(undefined)).toBeNull();
    expect(sanitizeSummary([1, 2])).toBeNull();
    expect(sanitizeSummary('4 sent')).toBeNull();
    expect(sanitizeSummary({})).toBeNull();
    expect(sanitizeSummary({ onlyText: 'x' })).toBeNull();
  });
});

// ── pruneJobRuns ────────────────────────────────────────────────────────────

test.describe('pruneJobRuns', () => {
  test('removes rows past the retention window and leaves the rest', async () => {
    const store = createMemoryQueueStore();
    const stamps = [
      '2026-01-01T00:00:00Z', // ~8 months old
      '2026-06-01T00:00:00Z', // ~3.5 months old
      '2026-09-01T00:00:00Z', // 13 days old
    ];
    for (const [i, iso] of stamps.entries()) {
      await recordRun(`job_${i}`, 1, 'schedule', async () => {}, { store, now: clock(iso) });
    }
    expect(store.runs).toHaveLength(3);

    const removed = await pruneJobRuns(90, { store, now: clock('2026-09-14T00:00:00Z') });
    expect(removed).toBe(2);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].startedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  test('the default window is 90 days and a silly window is clamped, not honoured', async () => {
    const store = createMemoryQueueStore();
    await recordRun('job_1', 1, 'schedule', async () => {}, {
      store,
      now: clock('2026-06-01T00:00:00Z'),
    });
    // 105 days old: inside no window shorter than that, outside the default.
    expect(await pruneJobRuns(undefined, { store, now: clock('2026-09-14T00:00:00Z') })).toBe(1);

    await recordRun('job_2', 1, 'schedule', async () => {}, {
      store,
      now: clock('2026-09-14T00:00:00Z'),
    });
    // 0 or negative would mean "delete everything, including the run in flight".
    expect(await pruneJobRuns(0, { store, now: clock('2026-09-14T00:00:00Z') })).toBe(0);
  });
});

// ── The SQL the model store cannot check ────────────────────────────────────

test.describe('the claim statement', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/jobs/queueStore.ts'),
    'utf8'
  );

  test('still says FOR UPDATE SKIP LOCKED, inside a transaction', () => {
    // Every one of these is a thing a well-meaning edit removes without any
    // test going red, and each one silently breaks exactly-one-owner:
    //   • no SKIP LOCKED  → the second worker blocks, the queue serialises;
    //   • no FOR UPDATE   → no lock at all, two workers claim the same job;
    //   • no $transaction → the lock is released before the UPDATE lands.
    expect(source).toContain('FOR UPDATE SKIP LOCKED');
    expect(source).toContain('prisma.$transaction');
    expect(source).toMatch(/ORDER BY priority DESC, runAt ASC/);
    expect(source).toMatch(/status = 'PENDING'/);
  });

  test('the MySQL 8.0.1 minimum is written down where the SQL is', () => {
    // SKIP LOCKED landed in MySQL 8.0.1. The deployed server is 8.0.46 and CI
    // runs the mysql:8.0 image, so this is a floor, not a risk — but an
    // undocumented floor is one a future "let us support MariaDB" ticket walks
    // straight into.
    const queue = fs.readFileSync(path.join(process.cwd(), 'src/lib/jobs/queue.ts'), 'utf8');
    expect(queue).toContain('MySQL 8.0.1');
    expect(source).toContain('8.0.1');
  });

  test('the claim does not increment attempts', () => {
    // #1673 owns attempt bookkeeping. Incrementing here would burn a retry on a
    // claim whose container died before it ran anything.
    const claimBlock = source.slice(source.indexOf('claimDue:'), source.indexOf('reapExpired:'));
    expect(claimBlock).not.toMatch(/attempts\s*:/);
  });
});
