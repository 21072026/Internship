// The dependency-free half of `emit()` (#1693): validate, record, fan out, and
// the delivery side the `event.deliver` job runs. `./emit.ts` binds it to
// Prisma and the job queue; a unit test binds it to memory.
//
// THE CONTRACT
//   1. The payload is checked against the catalogue (`validateEventPayload`).
//      An unknown name or a payload the catalogue does not describe THROWS
//      outside production — a producer drifting from the published webhook
//      contract is a red test, not a silent change for every receiver — and is
//      logged and dropped in production.
//   2. Exactly one `DomainEvent` row is written.
//   3. One job per interested subscriber is enqueued, keyed
//      `<eventId>:<subscriber>`, so a retried enqueue never makes a second row.
//   4. Everything else never throws, in any environment: like `logActivity`,
//      an event that cannot be recorded must not break the request that raised
//      it. A failed row write is logged and the event is lost (the
//      transactional outbox, #1680, is what closes that gap).
//
// DELIVERY
//   `deliverEvent()` loads the row, RE-PARSES its payload through the same
//   catalogue entry and hands the subscriber that object. Re-parsing is not
//   paranoia: MySQL's JSON column re-orders object keys, and the parsed object
//   comes out in the schema's key order — the order the producers wrote — so a
//   webhook body serialises exactly as it did when the producer posted it
//   directly (pinned in e2e/domain-event-emit.unit.spec.ts).

import { eventSubjectId, validateEventPayload, type EventActorType } from './catalog';
import { deliveryKey, type DeliveredEvent, type SubscriberRegistry } from './subscribers';

export interface EmitContext {
  /**
   * The tenant the event belongs to. Pass it whenever the call site knows it;
   * omitted, the request's bound org (`currentOrgId()`) is used. An explicit
   * `null` is kept as null — a legacy/system event with no tenant.
   */
  orgId?: string | null;
  actor?: { id?: string | null; type: EventActorType } | null;
  /** Defaults to the request id of the request in flight, when there is one. */
  correlationId?: string | null;
}

export interface NewDomainEvent {
  orgId: string | null;
  name: string;
  version: number;
  payload: Record<string, unknown>;
  actorId: string | null;
  actorType: EventActorType | null;
  subjectType: string | null;
  subjectId: string | null;
  correlationId: string | null;
}

export interface EmitterLogger {
  warning(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface EmitterDeps {
  registry: SubscriberRegistry;
  insertEvent(row: NewDomainEvent): Promise<{ id: string }>;
  enqueueDelivery(job: { eventId: string; subscriber: string; orgId: string | null; idempotencyKey: string }): Promise<unknown>;
  /** The ambient org when the caller did not pass one (`currentOrgId()`). */
  ambientOrgId?: () => string | null | undefined;
  /** The ambient correlation id (`ambientRequestId()`). */
  ambientCorrelationId?: () => string | null | undefined;
  /** True in production: an invalid event is logged and dropped instead of thrown. */
  production: boolean;
  logger: EmitterLogger;
}

export class InvalidDomainEventError extends Error {
  constructor(
    readonly eventName: string,
    readonly reason: 'unknown_event' | 'invalid_payload',
    readonly issues: string[] = [],
  ) {
    super(`emit(${eventName}): ${reason}${issues.length ? ` — ${issues.join('; ')}` : ''}`);
    this.name = 'InvalidDomainEventError';
  }
}

/** Resolves to the new event's id, or null when nothing was recorded. */
export type EmitFn = (name: string, payload: Record<string, unknown>, ctx?: EmitContext) => Promise<string | null>;

export function createEmitter(deps: EmitterDeps): EmitFn {
  return async function emit(name, payload, ctx = {}) {
    const check = validateEventPayload(name, payload);
    if (!check.ok) {
      const error = new InvalidDomainEventError(name, check.reason, check.issues);
      if (!deps.production) throw error;
      deps.logger.error('Domain event dropped: not in the catalogue', { event: name, reason: check.reason, issues: check.issues });
      return null;
    }

    const orgId = ctx.orgId !== undefined ? ctx.orgId : (deps.ambientOrgId?.() ?? null);
    let eventId: string;
    try {
      const row = await deps.insertEvent({
        orgId,
        name,
        version: check.definition.version,
        payload: check.payload,
        actorId: ctx.actor?.id ?? null,
        actorType: ctx.actor?.type ?? null,
        subjectType: check.definition.subjectType,
        subjectId: eventSubjectId(check.definition, check.payload),
        correlationId: ctx.correlationId !== undefined ? ctx.correlationId : (deps.ambientCorrelationId?.() ?? null),
      });
      eventId = row.id;
    } catch (e) {
      deps.logger.error('Domain event could not be recorded', { event: name, error: String(e) });
      return null;
    }

    for (const subscriber of deps.registry.interestedIn(name)) {
      try {
        await deps.enqueueDelivery({ eventId, subscriber, orgId, idempotencyKey: deliveryKey(eventId, subscriber) });
      } catch (e) {
        deps.logger.error('Domain event delivery could not be queued', { event: name, eventId, subscriber, error: String(e) });
      }
    }
    return eventId;
  };
}

export interface StoredDomainEvent extends Omit<DeliveredEvent, 'createdAt' | 'actorType'> {
  actorType: string | null;
  createdAt: Date | string;
}

export interface DeliverDeps {
  registry: SubscriberRegistry;
  loadEvent(eventId: string): Promise<StoredDomainEvent | null>;
  logger: EmitterLogger;
}

export type DeliveryOutcome = 'delivered' | 'missing_event' | 'unknown_subscriber' | 'not_subscribed';

/**
 * Run one subscriber for one recorded event — the body of the `event.deliver`
 * job. A handler's throw propagates (the job retries); everything this
 * function can decide on its own is an outcome, not a throw, because a retry
 * would decide the same way.
 */
export async function deliverEvent(deps: DeliverDeps, job: { eventId: string; subscriber: string }): Promise<DeliveryOutcome> {
  const subscriber = deps.registry.get(job.subscriber);
  if (!subscriber) {
    deps.logger.warning('Domain event delivery skipped: no such subscriber', job);
    return 'unknown_subscriber';
  }
  const row = await deps.loadEvent(job.eventId);
  if (!row) {
    // Pruned by retention, or the tenant was deleted with its events.
    deps.logger.warning('Domain event delivery skipped: event not found', job);
    return 'missing_event';
  }
  if (!subscriber.events.includes(row.name)) return 'not_subscribed';

  const parsed = validateEventPayload(row.name, row.payload, row.version);
  const payload = parsed.ok ? parsed.payload : (row.payload as Record<string, unknown>);
  await subscriber.handle({
    ...row,
    payload,
    actorType: (row.actorType as EventActorType | null) ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  });
  return 'delivered';
}
