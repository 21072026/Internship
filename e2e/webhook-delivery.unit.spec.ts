// Webhook delivery as a queued subscriber (#1695) — pure node, no browser, no
// database. Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// `runDeliveryAttempt()` (src/lib/webhookDeliveryRule.ts) is driven by the REAL
// worker loop on the memory queue store with a hand-moved clock, so the retry
// spacing, the attempt numbers and the DEAD ending are the production ones —
// minus Prisma and the network.
import { test, expect } from '@playwright/test';
import { createMemoryQueueStore, enqueue, setQueueLogger, type QueueStore } from '@/lib/jobs/queue';
import { createJobRegistry } from '@/lib/jobs/registry';
import { createWorker } from '@/lib/jobs/worker';
import {
  attemptStatus,
  classifyAttempt,
  clampReplayCount,
  nextHealth,
  runDeliveryAttempt,
  truncateText,
  webhookDeliveryId,
  webhookJobKey,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_REPLAY_MAX,
  WEBHOOK_RESPONSE_BODY_LIMIT,
  type AttemptResult,
  type DeliveryDeps,
  type DeliveryHook,
  type WebhookDeliveryStatusName,
} from '@/lib/webhookDeliveryRule';
import { createWebhookSubscriber } from '@/lib/events/subscribers/webhook';
import { WEBHOOK_EVENTS } from '@/lib/events/catalog';

setQueueLogger({ warning: () => {} });
const silent = { warning: () => {}, error: () => {}, info: () => {} };

interface Row {
  id: string;
  webhookId: string;
  eventId: string;
  deliveryId: string;
  attempt: number;
  status: WebhookDeliveryStatusName;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
}

function harness(answers: (AttemptResult | (() => AttemptResult))[], hookOverrides: Partial<DeliveryHook & { disabledAt: Date | null; active: boolean }> = {}) {
  let clock = new Date('2026-10-27T09:00:00.000Z');
  const now = () => clock;
  const store: QueueStore = createMemoryQueueStore();
  const rows: Row[] = [];
  const hook: DeliveryHook & { disabledAt: Date | null; active: boolean } = {
    id: 'hook-1', orgId: 'org-a', url: 'https://receiver.example/hook', secret: 's',
    consecutiveFailures: 0, failingSince: null, lastSuccessAt: null, disabledAt: null, active: true,
    ...hookOverrides,
  };
  const posted: string[] = [];
  const notices: string[] = [];
  let call = 0;
  const deps: DeliveryDeps = {
    loadEvent: async (id) => (id === 'evt-1' ? { id, name: 'mentorship.created', orgId: 'org-a', payload: { relationId: 'r1' } } : null),
    loadLiveHook: async (id, orgId) => (id === hook.id && orgId === hook.orgId && hook.active && !hook.disabledAt ? { ...hook } : null),
    insertAttempt: async (r) => {
      const row: Row = { id: `row-${rows.length + 1}`, ...r, status: 'PENDING', responseCode: null, responseBody: null, error: null };
      rows.push(row);
      return { id: row.id };
    },
    finishAttempt: async (id, patch) => void Object.assign(rows.find((r) => r.id === id)!, patch),
    saveHealth: async (_id, h, at) => {
      Object.assign(hook, { consecutiveFailures: h.consecutiveFailures, failingSince: h.failingSince, lastSuccessAt: h.lastSuccessAt });
      if (!h.disableReason || hook.disabledAt) return false;
      hook.disabledAt = at;
      return true;
    },
    post: async (_h, _e, deliveryId) => {
      posted.push(deliveryId);
      const a = answers[Math.min(call++, answers.length - 1)];
      return typeof a === 'function' ? a() : a;
    },
    notifyDisabled: async (_h, reason) => void notices.push(reason),
    now,
  };
  const jobs = createJobRegistry();
  jobs.register('webhook.deliver', async (payload, { attempt, job }) => {
    const outcome = await runDeliveryAttempt(deps, payload as { eventId: string; webhookId: string }, attempt, job.maxAttempts);
    return { [outcome]: 1 };
  });
  const worker = createWorker({ store, registry: jobs, workerId: 'test#1', concurrency: 1, logger: silent, ownedElsewhere: [], now, random: () => 0.5 });
  const queue = (eventId = 'evt-1') =>
    enqueue('webhook.deliver', { eventId, webhookId: hook.id }, { store, now, maxAttempts: WEBHOOK_MAX_ATTEMPTS, idempotencyKey: webhookJobKey(eventId, hook.id), orgId: 'org-a', trigger: 'event' });
  /** Tick, then jump the clock past any backoff, until the queue is quiet. */
  const drain = async (maxTicks = 40) => {
    for (let i = 0; i < maxTicks; i++) {
      await worker.tick();
      clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    }
  };
  return { rows, hook, posted, notices, queue, drain, store, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

const ok = (status = 200, body = 'ok'): AttemptResult => ({ kind: 'response', status, body, ms: 12 });

test.describe('webhook delivery (#1695)', { tag: '@smoke' }, () => {
  test('500, 500, 500, then 200 leaves four rows — the last one SUCCESS — with one X-Delivery-Id', async () => {
    const h = harness([ok(500), ok(500), ok(500), ok(200)]);
    await h.queue();
    await h.drain();
    expect(h.rows.map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED', 'SUCCESS']);
    expect(h.rows.map((r) => r.attempt)).toEqual([1, 2, 3, 4]);
    expect(h.rows.map((r) => r.responseCode)).toEqual([500, 500, 500, 200]);
    expect(new Set(h.posted)).toEqual(new Set([webhookDeliveryId('evt-1', 'hook-1')]));
    expect(h.hook.consecutiveFailures).toBe(0);
    expect(h.hook.lastSuccessAt).not.toBeNull();
  });

  test('a 5xx retries with backoff and ends DEAD after the last attempt; the job itself does not dead-letter', async () => {
    const h = harness([ok(503)]);
    const job = await h.queue();
    await h.drain();
    expect(h.rows).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(job.idempotencyKey).toBe(webhookJobKey('evt-1', 'hook-1'));
    expect(h.rows.at(-1)!.status).toBe('DEAD');
    expect(h.rows.slice(0, -1).every((r) => r.status === 'FAILED')).toBe(true);
    expect((await h.store.findJobByIdempotencyKey(job.idempotencyKey!))?.status).toBe('SUCCEEDED');
  });

  test('a 4xx does not retry', async () => {
    const h = harness([ok(404, 'no such hook')]);
    await h.queue();
    await h.drain();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: 'DEAD', responseCode: 404, responseBody: 'no such hook' });
  });

  test('a timeout retries; a URL the SSRF guard refuses does not', async () => {
    const timeout = harness([{ kind: 'error', error: 'TimeoutError: aborted', ms: 5000 }, ok(200)]);
    await timeout.queue();
    await timeout.drain();
    expect(timeout.rows.map((r) => r.status)).toEqual(['FAILED', 'SUCCESS']);

    const refused = harness([{ kind: 'error', error: 'SsrfBlockedError: private address', ms: 0, refused: true }]);
    await refused.queue();
    await refused.drain();
    expect(refused.rows.map((r) => r.status)).toEqual(['DEAD']);
    expect(refused.rows[0].error).toContain('private address');
  });

  test('a stored response body is truncated', async () => {
    const h = harness([ok(500, 'x'.repeat(2_000_000)), ok(200)]);
    await h.queue();
    await h.drain();
    expect(h.rows[0].responseBody!.length).toBeLessThan(WEBHOOK_RESPONSE_BODY_LIMIT + 100);
  });

  test('past the failure threshold the hook is disabled once, notified once, and skipped afterwards', async () => {
    const h = harness([ok(500)], { consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES - 2 });
    await h.queue();
    await h.drain();
    // Attempt 1 → 19 failures (retry), attempt 2 → 20: disabled, no further retry.
    expect(h.rows.map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
    expect(h.hook.disabledAt).not.toBeNull();
    expect(h.notices).toHaveLength(1);

    // The relay skips it: a second event writes no row and sends no notice.
    await h.queue('evt-1-again');
    await h.drain();
    expect(h.rows).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
  });

  test('a paused or deleted hook gets nothing and leaves no row', async () => {
    const h = harness([ok(200)], { active: false });
    await h.queue();
    await h.drain();
    expect(h.rows).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });

  test('the fan-out is keyed per (event × subscription): a second enqueue is the same job', async () => {
    const h = harness([ok(200)]);
    const a = await h.queue();
    const b = await h.queue();
    expect(b.id).toBe(a.id);
    expect(webhookJobKey('e', 'h1')).not.toBe(webhookJobKey('e', 'h2'));
  });
});

test.describe('webhook delivery rules', { tag: '@smoke' }, () => {
  test('classification', () => {
    expect(classifyAttempt(ok(200))).toBe('success');
    expect(classifyAttempt(ok(204))).toBe('success');
    expect(classifyAttempt(ok(500))).toBe('retryable');
    expect(classifyAttempt(ok(429))).toBe('retryable');
    expect(classifyAttempt(ok(408))).toBe('retryable');
    expect(classifyAttempt(ok(400))).toBe('permanent');
    expect(classifyAttempt(ok(410))).toBe('permanent');
    // A redirect is never followed (it would walk around the SSRF check).
    expect(classifyAttempt(ok(302))).toBe('permanent');
    expect(attemptStatus('retryable', 3, 8)).toBe('FAILED');
    expect(attemptStatus('retryable', 8, 8)).toBe('DEAD');
  });

  test('72 hours without a success disables even below the count threshold', () => {
    const since = new Date('2026-10-01T00:00:00Z');
    const later = new Date(since.getTime() + WEBHOOK_DISABLE_AFTER_MS);
    const h = nextHealth({ consecutiveFailures: 3, failingSince: since, lastSuccessAt: null }, 'retryable', later);
    expect(h.disableReason).toMatch(/72 hours/);
    expect(nextHealth({ consecutiveFailures: 3, failingSince: since, lastSuccessAt: null }, 'success', later)).toMatchObject({
      consecutiveFailures: 0, failingSince: null, disableReason: null,
    });
  });

  test('delivery id is stable per (event × hook) and opaque', () => {
    expect(webhookDeliveryId('e1', 'h1')).toBe(webhookDeliveryId('e1', 'h1'));
    expect(webhookDeliveryId('e1', 'h1')).not.toBe(webhookDeliveryId('e1', 'h2'));
    expect(webhookDeliveryId('e1', 'h1')).not.toContain('e1');
    expect(webhookDeliveryId('e1', 'h1').length).toBeLessThanOrEqual(64);
  });

  test('truncation and replay count', () => {
    expect(truncateText('abc', 10)).toBe('abc');
    expect(truncateText(null, 10)).toBeNull();
    expect(truncateText('abcdef', 3)).toMatch(/^abc… \[truncated, 6 chars\]$/);
    expect(clampReplayCount(5)).toBe(5);
    expect(clampReplayCount('7')).toBe(7);
    expect(clampReplayCount(500)).toBe(WEBHOOK_REPLAY_MAX);
    expect(clampReplayCount(0)).toBeNull();
    expect(clampReplayCount(1.5)).toBeNull();
    expect(clampReplayCount('x')).toBeNull();
  });

  test('the subscriber fans out every public event and posts nothing itself', async () => {
    const seen: string[] = [];
    const s = createWebhookSubscriber(async (e) => void seen.push(e.id));
    expect([...s.events]).toEqual([...WEBHOOK_EVENTS]);
    await s.handle({
      id: 'evt-9', name: 'mentorship.created', version: 1, payload: {}, orgId: 'o', actorId: null, actorType: null,
      subjectType: null, subjectId: null, correlationId: null, createdAt: new Date().toISOString(),
    });
    expect(seen).toEqual(['evt-9']);
  });
});
