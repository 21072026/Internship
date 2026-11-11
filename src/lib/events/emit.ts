// emit() — the one way a domain event is raised (#1693). Server-only.
//
//   await emit('mentorship.created', { relationId, mentorId, menteeId, companyId }, { orgId, actor });
//
// Validates against the catalogue (src/lib/events/catalog.ts), writes one
// `DomainEvent` row and enqueues one `event.deliver` job per interested
// subscriber (src/lib/events/subscribers/). The worker runs the subscribers,
// so a slow webhook receiver no longer holds the producer's request open, and
// delivery survives a restart. The rules are in ./emitCore.ts; this file only
// binds them to Prisma and the queue. docs/domain-events.md § emit().
//
// THE ROW INSERT. #1680 (transactional outbox) owns `publishEvent(tx, …)`; it
// has not landed, so `insertDomainEvent` below is the single insert path into
// `DomainEvent` until it does. When #1680 lands, this function becomes a call
// to `publishEvent` and the enqueue moves to its relay — nothing else changes.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { currentOrgId } from '@/lib/orgContext';
import { ambientRequestId } from '@/lib/requestId';
import { enqueue } from '@/lib/jobs/queue';
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import type { DomainEventName, EventPayload } from './catalog';
import { createEmitter, deliverEvent, type DeliveryOutcome, type EmitContext, type NewDomainEvent } from './emitCore';
import { subscriberRegistry } from './subscribers';
import { registerAllSubscribers } from './subscribers/index';

export type { EmitContext } from './emitCore';

async function insertDomainEvent(row: NewDomainEvent): Promise<{ id: string }> {
  return prisma.domainEvent.create({
    data: { ...row, payload: row.payload as Prisma.InputJsonValue },
    select: { id: true },
  });
}

let emitter: ReturnType<typeof createEmitter> | null = null;

function getEmitter() {
  if (!emitter) {
    registerAllSubscribers();
    emitter = createEmitter({
      registry: subscriberRegistry,
      insertEvent: insertDomainEvent,
      enqueueDelivery: ({ eventId, subscriber, orgId, idempotencyKey }) =>
        enqueue('event.deliver', { eventId, subscriber }, { orgId, idempotencyKey, trigger: 'event' }),
      ambientOrgId: currentOrgId,
      ambientCorrelationId: ambientRequestId,
      production: process.env.NODE_ENV === 'production',
      logger,
    });
  }
  return emitter;
}

/**
 * Raise a domain event. Resolves to the new `DomainEvent` id, or null when
 * nothing was recorded. Never rejects in production; outside production an
 * event the catalogue does not describe rejects (InvalidDomainEventError).
 */
export function emit<N extends DomainEventName>(name: N, payload: EventPayload<N>, ctx?: EmitContext): Promise<string | null> {
  return getEmitter()(name, payload as Record<string, unknown>, ctx);
}

/**
 * `emit()` inside a caller's interactive transaction (#1998): the `DomainEvent`
 * row and its `event.deliver` jobs are written THROUGH `tx`, so a rollback —
 * a refused write later in the unit, an import's dry run — takes the event
 * with it, and the worker sees it only once the transaction commits. The
 * transactional half of the outbox (#1680) for producers that already run in
 * a transaction; everything else still calls `emit()`.
 */
export function emitInTransaction<N extends DomainEventName>(
  tx: Prisma.TransactionClient,
  name: N,
  payload: EventPayload<N>,
  ctx?: EmitContext,
): Promise<string | null> {
  registerAllSubscribers();
  const inTx = createEmitter({
    registry: subscriberRegistry,
    insertEvent: (row) => tx.domainEvent.create({ data: { ...row, payload: row.payload as Prisma.InputJsonValue }, select: { id: true } }),
    enqueueDelivery: ({ eventId, subscriber, orgId, idempotencyKey }) =>
      enqueue('event.deliver', { eventId, subscriber }, { orgId, idempotencyKey, trigger: 'event', store: prismaQueueStore(tx) }),
    ambientOrgId: currentOrgId,
    ambientCorrelationId: ambientRequestId,
    production: process.env.NODE_ENV === 'production',
    logger,
  });
  return inTx(name, payload as Record<string, unknown>, ctx);
}

/** The `event.deliver` job body (registered in src/jobs/index.ts). */
export function runEventDelivery(job: { eventId: string; subscriber: string }): Promise<DeliveryOutcome> {
  registerAllSubscribers();
  return deliverEvent(
    {
      registry: subscriberRegistry,
      loadEvent: async (id) => {
        const row = await prisma.domainEvent.findUnique({ where: { id } });
        return row ? { ...row, payload: row.payload as Record<string, unknown> } : null;
      },
      logger,
    },
    job,
  );
}
