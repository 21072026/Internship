// Who listens to which event — the lookup the relay fans out over (#1680).
//
// This is the seam, not the feature: `emit()` and the subscribers themselves,
// with their handlers, are #1693. What the relay needs from it is one answer —
// "which subscriber names want event X?" — so a committed event becomes one
// `events.deliver` job per name. Until a subscriber registers, the relay
// marks every event RELAYED with nothing to deliver, which is correct: the
// row is the record, and nobody was listening.
//
// Registration is keyed by name and idempotent, like the retention registry:
// a module re-evaluated by the dev server leaves one entry, not two. The name
// is part of the delivery job's idempotency key (`${eventId}:${name}`), so it
// must be stable — renaming a subscriber re-delivers nothing and loses nothing
// only if no event is mid-flight.

import type { DomainEventName } from './catalog';

/** Job name of one event delivered to one subscriber. */
export const DELIVER_JOB_NAME = 'events.deliver';

/** Stable, short, and safe inside an idempotency key. */
export const SUBSCRIBER_NAME = /^[a-z][a-z0-9_.-]{1,47}$/;

export interface SubscriberRegistration {
  name: string;
  /** The events it wants; `'*'` for every event in the catalogue. */
  events: readonly DomainEventName[] | '*';
}

const registry = new Map<string, SubscriberRegistration>();

export function registerSubscriberEvents(reg: SubscriberRegistration): void {
  if (!SUBSCRIBER_NAME.test(reg.name)) throw new Error(`Invalid subscriber name: ${reg.name}`);
  registry.set(reg.name, reg);
}

/** Subscriber names for one event, sorted so the fan-out order is stable. */
export function subscribersFor(eventName: string): string[] {
  const out: string[] = [];
  for (const reg of registry.values()) {
    if (reg.events === '*' || (reg.events as readonly string[]).includes(eventName)) out.push(reg.name);
  }
  return out.sort();
}

/** The delivery job's idempotency key: a relay retry cannot enqueue a second delivery. */
export function deliveryKey(eventId: string, subscriber: string): string {
  return `${eventId}:${subscriber}`;
}

/** Test seam. */
export function clearSubscriberRegistry(): void {
  registry.clear();
}
