// The subscriber registry (#1693): who reacts to which domain event.
//
// A subscriber is a NAME, a list of event names and a handler. `emit()` asks
// the registry which subscribers want an event and enqueues one `event.deliver`
// job per subscriber whose payload is `{ eventId, subscriber }` — two strings.
// The worker resolves the handler by name when the job runs, so a job row never
// stores a closure and a deploy that renames or drops a subscriber leaves rows
// it can recognise as orphaned instead of code it cannot run.
//
// Handlers are at-least-once (docs/job-worker.md): a container killed after the
// side effect but before the job settled runs it again. Each subscriber says in
// its own file what makes a second run harmless — or, like the webhook
// subscriber, that it accepts the repeat and why.
//
// Pure: no Prisma, no logger. The process-wide registrations live in
// `./subscribers/index.ts`; a unit test builds its own with
// `createSubscriberRegistry()`.

import type { EventActorType } from './catalog';

/** A committed `DomainEvent` row as a subscriber receives it. JSON-safe. */
export interface DeliveredEvent<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  version: number;
  payload: P;
  orgId: string | null;
  actorId: string | null;
  actorType: EventActorType | null;
  subjectType: string | null;
  subjectId: string | null;
  correlationId: string | null;
  /** ISO instant the row was written. */
  createdAt: string;
}

export interface SubscriberDefinition {
  /** Stored in the job payload and in the idempotency key — keep it stable. */
  name: string;
  /** The event names this subscriber wants. Never empty. */
  events: readonly string[];
  /**
   * React to one event. Throwing makes the job retry with backoff and, after
   * `maxAttempts`, dead-letter — so throw only when a retry can help.
   */
  handle: (event: DeliveredEvent) => Promise<void> | void;
}

// A subscriber name is part of `Job.idempotencyKey` (`<eventId>:<name>`), so it
// may not contain the separator and stays short.
export const SUBSCRIBER_NAME = /^[a-z][a-z0-9_.-]{0,47}$/;

export interface SubscriberRegistry {
  register(definition: SubscriberDefinition): void;
  get(name: string): SubscriberDefinition | undefined;
  /** Names of the subscribers that want `eventName`, sorted. */
  interestedIn(eventName: string): string[];
  names(): string[];
}

export function createSubscriberRegistry(): SubscriberRegistry {
  const byName = new Map<string, SubscriberDefinition>();
  return {
    register(definition) {
      if (!SUBSCRIBER_NAME.test(definition.name)) throw new Error(`invalid subscriber name: ${definition.name}`);
      // Two files claiming one name is a wiring mistake, not "last one wins".
      if (byName.has(definition.name)) throw new Error(`subscriber already registered: ${definition.name}`);
      if (definition.events.length === 0) throw new Error(`subscriber ${definition.name} subscribes to no event`);
      byName.set(definition.name, definition);
    },
    get: (name) => byName.get(name),
    interestedIn: (eventName) =>
      [...byName.values()]
        .filter((s) => s.events.includes(eventName))
        .map((s) => s.name)
        .sort(),
    names: () => [...byName.keys()].sort(),
  };
}

/** The process-wide registry `emit()` and the `event.deliver` handler read. */
export const subscriberRegistry: SubscriberRegistry = createSubscriberRegistry();

export function registerSubscriber(definition: SubscriberDefinition): void {
  subscriberRegistry.register(definition);
}

/** `Job.idempotencyKey` of one delivery: a retried emit never enqueues it twice. */
export function deliveryKey(eventId: string, subscriber: string): string {
  return `${eventId}:${subscriber}`;
}
