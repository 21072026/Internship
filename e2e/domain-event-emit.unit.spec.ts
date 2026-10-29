// emit() and the subscriber registry (#1693) — pure node, no browser, no
// database. Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// The emitter is driven through `createEmitter()` (src/lib/events/emitCore.ts)
// against an in-memory DomainEvent table and the real job queue on its memory
// store, and the `event.deliver` job is run by the real worker loop — so the
// chain emit → row → keyed job → handler resolved BY NAME → subscriber is the
// production one, minus Prisma.
//
// The last block is the behaviour lock for moving the producers onto emit()
// (#1697): every payload a producer dispatches today reaches the webhook
// dispatcher byte-for-byte as before — same event, same `data` JSON, same org —
// even after a trip through a MySQL JSON column, which re-orders keys.
import { test, expect } from '@playwright/test';
import { createMemoryQueueStore, enqueue, setQueueLogger } from '@/lib/jobs/queue';
import { createJobRegistry } from '@/lib/jobs/registry';
import { createWorker } from '@/lib/jobs/worker';
import { WEBHOOK_EVENTS } from '@/lib/events/catalog';
import { createEmitter, deliverEvent, InvalidDomainEventError, type NewDomainEvent, type StoredDomainEvent } from '@/lib/events/emitCore';
import { createSubscriberRegistry, deliveryKey, type DeliveredEvent, type SubscriberRegistry } from '@/lib/events/subscribers';
import { createWebhookSubscriber } from '@/lib/events/subscribers/webhook';

setQueueLogger({ warning: () => {} });

const silent = { warning: () => {}, error: () => {}, info: () => {} };
const at = '2026-10-20T09:30:00.000Z';

// MySQL stores a JSON object with its keys sorted by length, then bytewise —
// the order a webhook body would come out in if delivery serialised the row as
// read back.
function mysqlJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mysqlJson);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, mysqlJson((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function harness(opts: { production?: boolean; registry?: SubscriberRegistry; ambientOrgId?: string | null; failInsert?: boolean; failEnqueue?: boolean } = {}) {
  const rows: (StoredDomainEvent & { id: string })[] = [];
  const store = createMemoryQueueStore();
  const registry = opts.registry ?? createSubscriberRegistry();
  const logs: string[] = [];
  const logger = { warning: (m: string) => logs.push(`warning:${m}`), error: (m: string) => logs.push(`error:${m}`) };
  const emit = createEmitter({
    registry,
    production: opts.production ?? false,
    logger,
    ambientOrgId: () => opts.ambientOrgId,
    ambientCorrelationId: () => 'req-1',
    insertEvent: async (row: NewDomainEvent) => {
      if (opts.failInsert) throw new Error('ECONNREFUSED mysql');
      const id = `evt_${rows.length + 1}`;
      // What the row reads back as: JSON-round-tripped, keys re-ordered.
      rows.push({ id, ...row, payload: mysqlJson(JSON.parse(JSON.stringify(row.payload))) as Record<string, unknown>, createdAt: new Date(at) });
      return { id };
    },
    enqueueDelivery: async ({ eventId, subscriber, orgId, idempotencyKey }) => {
      if (opts.failEnqueue) throw new Error('queue down');
      return enqueue('event.deliver', { eventId, subscriber }, { store, orgId, idempotencyKey, trigger: 'event' });
    },
  });
  const jobs = createJobRegistry();
  jobs.register('event.deliver', async (payload) => {
    const outcome = await deliverEvent(
      { registry, logger, loadEvent: async (id) => rows.find((r) => r.id === id) ?? null },
      payload as { eventId: string; subscriber: string },
    );
    return { [outcome]: 1 };
  });
  const worker = createWorker({ store, registry: jobs, workerId: 'test#1', concurrency: 4, logger: silent, ownedElsewhere: [] });
  return { emit, rows, store, registry, worker, logs };
}

test.describe('emit() and the subscriber registry', { tag: '@smoke' }, () => {
  test('emit → one DomainEvent row → one keyed job per subscriber → the subscriber gets the typed payload', async () => {
    const seen: DeliveredEvent[] = [];
    const registry = createSubscriberRegistry();
    registry.register({ name: 'test-sub', events: ['mentorship.created'], handle: (e) => void seen.push(e) });
    registry.register({ name: 'other', events: ['evaluation.added'], handle: () => {} });
    const h = harness({ registry });

    const payload = { relationId: 'r1', mentorId: 'u1', menteeId: 'u2', companyId: null };
    const id = await h.emit('mentorship.created', payload, { orgId: 'org-a', actor: { id: 'admin-1', type: 'user' } });

    expect(id).toBe('evt_1');
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      orgId: 'org-a',
      name: 'mentorship.created',
      version: 1,
      actorId: 'admin-1',
      actorType: 'user',
      subjectType: 'MentorshipRelation',
      subjectId: 'r1',
      correlationId: 'req-1',
    });
    // Only the interested subscriber got a job, and the row stores two strings.
    expect(h.store.jobs).toHaveLength(1);
    expect(h.store.jobs[0]).toMatchObject({
      name: 'event.deliver',
      payload: { eventId: 'evt_1', subscriber: 'test-sub' },
      idempotencyKey: deliveryKey('evt_1', 'test-sub'),
      orgId: 'org-a',
      trigger: 'event',
    });

    const tick = await h.worker.tick();
    expect(tick).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 'evt_1', name: 'mentorship.created', orgId: 'org-a', createdAt: at });
    expect(JSON.stringify(seen[0].payload)).toBe(JSON.stringify(payload));
  });

  test('a repeated enqueue of the same delivery makes no second job row', async () => {
    const store = createMemoryQueueStore();
    const key = deliveryKey('evt_9', 'webhook');
    const a = await enqueue('event.deliver', { eventId: 'evt_9', subscriber: 'webhook' }, { store, idempotencyKey: key });
    const b = await enqueue('event.deliver', { eventId: 'evt_9', subscriber: 'webhook' }, { store, idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(store.jobs).toHaveLength(1);
  });

  test('outside production an event the catalogue does not describe throws; nothing is written', async () => {
    const h = harness();
    await expect(h.emit('no.such.event', {})).rejects.toBeInstanceOf(InvalidDomainEventError);
    await expect(h.emit('mentorship.created', { relationId: 'r1', extra: true })).rejects.toThrow(/invalid_payload/);
    expect(h.rows).toHaveLength(0);
    expect(h.store.jobs).toHaveLength(0);
  });

  test('in production emit never rejects: invalid events, a dead DB and a dead queue are logged', async () => {
    const p = harness({ production: true });
    expect(await p.emit('no.such.event', {})).toBeNull();
    expect(await p.emit('evaluation.added', { relationId: 'r1' })).toBeNull();
    expect(p.rows).toHaveLength(0);
    expect(p.logs.filter((l) => l.startsWith('error:'))).toHaveLength(2);

    const sub = createSubscriberRegistry();
    sub.register({ name: 'test-sub', events: ['evaluation.added'], handle: () => {} });
    const ok = { relationId: 'r1', type: 'INTERIM', authorId: 'u1' };
    // The never-throws half holds in every environment, not only production.
    for (const production of [true, false]) {
      expect(await harness({ production, registry: sub, failInsert: true }).emit('evaluation.added', ok)).toBeNull();
      const q = harness({ production, registry: sub, failEnqueue: true });
      expect(await q.emit('evaluation.added', ok)).toBe('evt_1');
      expect(q.logs.some((l) => l.includes('could not be queued'))).toBe(true);
    }
  });

  test('orgId: an explicit value (null included) wins; omitted, the ambient org is used', async () => {
    const h = harness({ ambientOrgId: 'org-ambient' });
    const ok = { relationId: 'r1', type: 'INTERIM', authorId: 'u1' };
    await h.emit('evaluation.added', ok, { orgId: 'org-x' });
    await h.emit('evaluation.added', ok, { orgId: null });
    await h.emit('evaluation.added', ok);
    expect(h.rows.map((r) => r.orgId)).toEqual(['org-x', null, 'org-ambient']);
  });

  test('a job for a subscriber that no longer exists, or an event that was pruned, settles without retrying', async () => {
    const registry = createSubscriberRegistry();
    registry.register({ name: 'test-sub', events: ['evaluation.added'], handle: () => {} });
    const deps = { registry, logger: silent, loadEvent: async () => null };
    expect(await deliverEvent(deps, { eventId: 'e1', subscriber: 'gone' })).toBe('unknown_subscriber');
    expect(await deliverEvent(deps, { eventId: 'e1', subscriber: 'test-sub' })).toBe('missing_event');
  });

  test('the registry refuses a duplicate name, an empty interest list and a name that breaks the key', () => {
    const r = createSubscriberRegistry();
    r.register({ name: 'a', events: ['evaluation.added'], handle: () => {} });
    expect(() => r.register({ name: 'a', events: ['evaluation.added'], handle: () => {} })).toThrow(/already registered/);
    expect(() => r.register({ name: 'b', events: [], handle: () => {} })).toThrow(/no event/);
    expect(() => r.register({ name: 'c:d', events: ['evaluation.added'], handle: () => {} })).toThrow(/invalid subscriber name/);
  });
});

// One object per producer call site, as dispatched directly before #1697 —
// the same list e2e/domain-event-catalog.unit.spec.ts pins.
const PRODUCERS: [site: string, event: string, payload: Record<string, unknown>][] = [
  ['api/apply', 'application.created', { mentorId: 'u1', menteeName: 'Ada Example', email: 'ada@example.test' }],
  ['stageChangeEffects', 'pipeline.stage_change', { relationId: 'r1', from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' }],
  ['api/mentorship', 'mentorship.created', { relationId: 'r1', mentorId: 'u1', menteeId: 'u2', companyId: null }],
  ['interactionWrite', 'interaction.logged', { relationId: 'r1', type: 'Feedback', date: at }],
  ['meetingAutoLog', 'interaction.logged', { relationId: 'r1', type: 'Meeting', date: at, autoLogged: true }],
  ['api/evaluations', 'evaluation.added', { relationId: 'r1', type: 'INTERIM', authorId: 'u1' }],
  ['api/meetings', 'meeting.scheduled', { title: 'Weekly', scheduledAt: at, count: 3 }],
  ['api/meetings/instant', 'meeting.scheduled', { title: 'Now', scheduledAt: null, count: 1, instant: true }],
  ['api/meeting-series', 'meeting.scheduled', { title: 'Series', scheduledAt: at, count: 2, seriesId: 's1' }],
  ['api/interview-panels/[id]/score', 'interview_panel.completed', { panelId: 'p1', subjectId: 'u2' }],
];

test.describe('the webhook subscriber delivers what the producers dispatched directly', { tag: '@smoke' }, () => {
  test('it subscribes to exactly the public (webhook) events', () => {
    const s = createWebhookSubscriber(async () => {});
    expect(s.name).toBe('webhook');
    expect([...s.events]).toEqual([...WEBHOOK_EVENTS]);
  });

  for (const [site, event, payload] of PRODUCERS) {
    test(`${site}: same event, same data JSON, same org`, async () => {
      const calls: [string, Record<string, unknown>, string | null | undefined][] = [];
      const registry = createSubscriberRegistry();
      registry.register(createWebhookSubscriber(async (e) => void calls.push([e.name, e.payload, e.orgId])));
      const h = harness({ registry });

      await h.emit(event, payload, { orgId: 'org-a' });
      await h.worker.tick();

      expect(calls).toHaveLength(1);
      const [sentEvent, sentData, sentOrg] = calls[0];
      expect(sentEvent).toBe(event);
      expect(sentOrg).toBe('org-a');
      // The body is JSON.stringify({ event, data, sentAt }): byte-identical data.
      expect(JSON.stringify(sentData)).toBe(JSON.stringify(payload));
    });
  }
});
