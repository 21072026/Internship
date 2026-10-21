// The transactional write path of the event bus (#1680).
//
// THE OUTBOX IS THE BUS. A domain event is a `DomainEvent` row written in the
// SAME transaction as the state change it describes, so the two commit or roll
// back together: there is no window in which the stage moved and nobody will
// ever hear of it, and none in which receivers hear of a move that rolled back.
// Delivery happens later, from the committed row — the relay
// (`./relay.ts`) turns it into one queue job per subscriber.
//
// THREE WAYS IN, ONE ROW SHAPE
//   publishEvent(tx, input)   inside an interactive `$transaction(async (tx) => …)`.
//                             The parameter type REFUSES the root client (it has
//                             `$transaction`, a transaction client does not), and
//                             a runtime check refuses it again for JS callers.
//   publishEventOp(input)     one element of an array `$transaction([...])` —
//                             the shape the bulk and status-change routes use.
//                             Unawaited on its own it does nothing, which is the
//                             point: it only exists inside the array.
//   withEvents(fn)            opens the transaction for a caller that has none,
//                             hands it `tx` and `publish`, and kicks the relay
//                             once the transaction committed.
//
// The vocabulary is `./catalog.ts` and nowhere else: every payload is checked
// against its catalogue entry here and an invalid one THROWS — inside the
// caller's transaction, so a producer that drifted from the published shape
// rolls its own write back instead of shipping a malformed event.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ambientRequestId } from '@/lib/requestId';
import { logger } from '@/lib/logger';
import {
  eventSubjectId,
  validateEventPayload,
  type DomainEventName,
  type EventActorType,
} from './catalog';

export interface PublishInput {
  name: DomainEventName;
  /** Defaults to the catalogue's latest version of `name`. */
  version?: number;
  payload: Record<string, unknown>;
  /**
   * The tenant the event belongs to. Required, never inferred from a bound
   * context: many producers are sessionless (crons, the public apply form) and
   * an event without an org reaches no tenant's subscribers.
   */
  orgId: string | null;
  actor?: { id: string | null; type: EventActorType } | null;
  /** Overrides the catalogue's subjectType / the payload's `subjectKey` field. */
  subject?: { type: string; id: string | null };
  /** Defaults to the request id in flight, so one request's events can be grouped. */
  correlationId?: string | null;
}

/** A client that is inside a transaction: the root client has `$transaction`, this must not. */
export type EventTx = Prisma.TransactionClient & { $transaction?: never };

export class InvalidEventError extends Error {
  constructor(
    readonly eventName: string,
    readonly reason: string,
    readonly issues: string[] = [],
  ) {
    super(`Domain event ${eventName} refused: ${reason}${issues.length ? ` (${issues.join('; ')})` : ''}`);
    this.name = 'InvalidEventError';
  }
}

// Strictly increasing per process. Two events written in the same millisecond
// by one transaction — a two-step move such as INTERVIEW → OFFER → HIRED — would
// otherwise tie on `createdAt`, and the relay's per-subject order is by
// `createdAt`. Across processes the order is that of the commits anyway.
let lastStamp = 0;
function nextStamp(): Date {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp);
}

/** Validate against the catalogue and build the row. Throws InvalidEventError. */
export function domainEventData(input: PublishInput): Prisma.DomainEventUncheckedCreateInput {
  const check = validateEventPayload(input.name, input.payload, input.version);
  if (!check.ok) throw new InvalidEventError(input.name, check.reason, check.issues);
  const { definition, payload } = check;
  return {
    orgId: input.orgId,
    name: definition.name,
    version: definition.version,
    payload: payload as Prisma.InputJsonValue,
    actorId: input.actor?.id ?? null,
    actorType: input.actor?.type ?? null,
    subjectType: input.subject?.type ?? definition.subjectType,
    subjectId: input.subject ? input.subject.id : eventSubjectId(definition, payload),
    correlationId: input.correlationId === undefined ? (ambientRequestId() ?? null) : input.correlationId,
    createdAt: nextStamp(),
  };
}

/** Write one event inside the caller's interactive transaction. */
export async function publishEvent(tx: EventTx, input: PublishInput): Promise<{ id: string }> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === 'function') {
    // Reached only by a cast or plain JS: the type already refuses the root client.
    throw new Error('publishEvent() must be given the transaction client, not the root Prisma client');
  }
  return tx.domainEvent.create({ data: domainEventData(input), select: { id: true } });
}

/**
 * One event as an element of an array `$transaction([...])`. Validation runs
 * NOW (before the transaction starts), so a bad payload aborts the whole batch.
 */
export function publishEventOp(input: PublishInput) {
  return prisma.domainEvent.create({ data: domainEventData(input), select: { id: true } });
}

/**
 * Open a transaction for a caller that has none. `publish` writes into it; once
 * it committed and something was published, the relay is kicked so delivery
 * does not wait for the next tick.
 */
export async function withEvents<T>(
  fn: (ctx: { tx: EventTx; publish: (input: PublishInput) => Promise<{ id: string }> }) => Promise<T>,
): Promise<T> {
  let published = 0;
  const result = await prisma.$transaction(async (tx) =>
    fn({
      tx,
      publish: (input) => {
        published++;
        return publishEvent(tx, input);
      },
    }),
  );
  if (published > 0) kickRelay();
  return result;
}

/**
 * The fallback for a producer whose write is not (yet) in a transaction it can
 * share: the event is durable from this point on, but not atomic with the
 * write before it. Never throws — the caller's write already committed, and
 * failing it now would report an error for a change that happened. Each caller
 * of this is a burndown entry in docs/domain-events.md.
 */
export async function publishAfterCommit(input: PublishInput): Promise<void> {
  try {
    await withEvents(({ publish }) => publish(input));
  } catch (e) {
    logger.error('domain_event.publish_failed', {
      event: input.name,
      error: e instanceof InvalidEventError ? e.message : e instanceof Error ? e.name : 'unknown',
    });
  }
}

/**
 * Ask the relay to run soon, in this process. Coalesced: a kick while a relay
 * pass is running schedules exactly one more pass. Fire-and-forget; the 30 s
 * tick (src/instrumentation.ts) is the guarantee, this is only latency.
 */
let relaying = false;
let again = false;
export function kickRelay(): void {
  if (process.env.EVENTS_RELAY_ENABLED === '0') return;
  if (relaying) {
    again = true;
    return;
  }
  relaying = true;
  setImmediate(async () => {
    try {
      do {
        again = false;
        const { relayOnce } = await import('./relay');
        await relayOnce();
      } while (again);
    } catch (e) {
      logger.warning('domain_event.relay_kick_failed', { error: e instanceof Error ? e.name : 'unknown' });
    } finally {
      relaying = false;
    }
  });
}
