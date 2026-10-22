// Unit tests for the cron jobs on the queue (#1677) — pure node, no browser,
// no database. Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// Proves the dormancy chain (the sweep enqueues the check-in and the mentor
// reminder only when it succeeded, once per sweep job), the route-key → job
// mapping of `GET /api/cron?…&enqueue=1`, the counters-only summary, and that
// the worker binds a job's org around its handler and nothing else.
import { test, expect } from '@playwright/test';
import { createMemoryQueueStore, enqueue, setQueueLogger } from '@/lib/jobs/queue';
import { createJobRegistry } from '@/lib/jobs/registry';
import { createWorker } from '@/lib/jobs/worker';
import { DORMANCY_CHAIN, dormancySweepHandler } from '@/jobs/dormancyChain';
import { counters } from '@/jobs/summary';
import { ENQUEUEABLE_KEYS, manualJobFor } from '@/lib/jobs/manualJobs';
import { JOB_NAMES } from '@/lib/jobs/types';

setQueueLogger({ warning: () => {} });

function harness(sweep: () => Promise<object>) {
  const store = createMemoryQueueStore();
  const registry = createJobRegistry();
  registry.register(
    'dormancy.sweep',
    dormancySweepHandler({
      sweep,
      enqueueNext: (name, idempotencyKey, trigger) => enqueue(name, {}, { store, idempotencyKey, trigger }),
    })
  );
  const worker = createWorker({ store, registry, workerId: 'w#1', random: () => 0.5 });
  return { store, worker };
}

test.describe('the dormancy chain', () => {
  test('a successful sweep enqueues the check-in and the mentor reminder, after it', { tag: '@smoke' }, async () => {
    const order: string[] = [];
    const h = harness(async () => {
      order.push('sweep');
      return { flagged: 2, cleared: 1 };
    });
    const sweep = await enqueue('dormancy.sweep', {}, { store: h.store });

    expect((await h.worker.tick()).succeeded).toBe(1);

    const chained = h.store.jobs.filter((j) => j.id !== sweep.id);
    expect(chained.map((j) => j.name)).toEqual([...DORMANCY_CHAIN]);
    expect(chained.every((j) => j.status === 'PENDING' && j.trigger === 'schedule')).toBe(true);
    expect(order).toEqual(['sweep']);
    expect(h.store.runs[0].patch?.summary).toEqual({ flagged: 2, cleared: 1, chained: 2 });
  });

  test('a failing sweep enqueues nothing downstream and retries', async () => {
    const h = harness(async () => {
      throw new Error('db down');
    });
    await enqueue('dormancy.sweep', {}, { store: h.store });

    expect((await h.worker.tick()).retried).toBe(1);
    expect(h.store.jobs).toHaveLength(1);
  });

  test('a re-run of the same sweep job enqueues the chain once; a manual sweep chains manual jobs', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return {};
    });
    const handler = dormancySweepHandler({
      sweep: async () => ({}),
      enqueueNext: (name, idempotencyKey, trigger) => enqueue(name, {}, { store: h.store, idempotencyKey, trigger }),
    });
    const job = await enqueue('dormancy.sweep', {}, { store: h.store, trigger: 'manual' });
    const ctx = { job: { ...job }, attempt: 1, signal: new AbortController().signal };
    await handler({}, ctx);
    await handler({}, ctx);
    const chained = h.store.jobs.filter((j) => j.id !== job.id);
    expect(chained).toHaveLength(2);
    expect(chained.every((j) => j.trigger === 'manual')).toBe(true);
    expect(calls).toBe(0);
  });
});

test.describe('GET /api/cron?…&enqueue=1 mapping', () => {
  test('every mapped key names a real job; own-org keys always carry the caller org', () => {
    for (const key of ENQUEUEABLE_KEYS) {
      const plan = manualJobFor(key, { orgId: 'org_1' });
      expect(plan, key).not.toBeNull();
      expect(JOB_NAMES).toContain(plan!.name);
    }
    expect(manualJobFor('relation-health', { orgId: 'org_1', at: '2026-10-01T00:00:00Z' })).toEqual({
      name: 'relationHealth.sweep',
      payload: { orgIds: ['org_1'], at: '2026-10-01T00:00:00Z' },
      orgId: 'org_1',
    });
    // An own-org job with no org is refused, never widened to every tenant.
    expect(manualJobFor('surveys', { orgId: null })).toBeNull();
    expect(manualJobFor('surveys', { orgId: 'o', batch: '3' })?.payload).toEqual({ orgIds: ['o'], batch: 3 });
  });

  test('a platform job runs for every tenant, trial-reminders narrows to the allowed org', () => {
    expect(manualJobFor('usage-rollup', { orgId: null })).toEqual({ name: 'usage.rollup', payload: {}, orgId: null });
    expect(manualJobFor('trial-reminders', { orgId: 'org_m' })).toEqual({
      name: 'trial.reminders',
      payload: { orgIds: ['org_m'] },
      orgId: 'org_m',
    });
    expect(manualJobFor('dormant', { orgId: null })?.name).toBe('dormancy.sweep');
  });

  test('the batch, re-engagement and unknown keys are not enqueueable', () => {
    for (const key of [null, '', 're-engagement', 'no-such-job']) {
      expect(manualJobFor(key, { orgId: 'org_1' }), String(key)).toBeNull();
    }
    // A junk clock is dropped, not passed on.
    expect(manualJobFor('evaluations', { orgId: 'o', at: 'yesterday' })?.payload).toEqual({ orgIds: ['o'] });
  });
});

test.describe('handler plumbing', () => {
  test('counters keeps numbers, booleans as 0/1 and array lengths — never ids or dates', () => {
    expect(
      counters({ sent: 3, ok: true, failed: false, ids: ['a', 'b'], at: new Date(), name: 'x', nested: { n: 1 }, bad: NaN })
    ).toEqual({ sent: 3, ok: 1, failed: 0, ids: 2 });
    expect(counters(null)).toEqual({});
  });

  test("the worker binds a job's org around its handler, and runs an org-less job unbound", async () => {
    const store = createMemoryQueueStore();
    const registry = createJobRegistry();
    const seen: (string | null)[] = [];
    let bound: string | null = null;
    registry.register('test.org', async () => {
      seen.push(bound);
    });
    const worker = createWorker({
      store,
      registry,
      workerId: 'w#1',
      bindOrg: (orgId, fn) => {
        bound = orgId;
        try {
          return fn();
        } finally {
          bound = null;
        }
      },
    });
    await enqueue('test.org' as never, {} as never, { store, orgId: 'org_a' });
    await enqueue('test.org' as never, {} as never, { store });
    await worker.tick();
    expect(seen.sort()).toEqual([null, 'org_a'].sort());
  });
});
