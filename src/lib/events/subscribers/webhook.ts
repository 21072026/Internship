// The webhook subscriber (#1693): a public domain event → a signed POST to every
// live subscription of the event's tenant. The one legitimate caller of
// `dispatchWebhook` (scripts/check-events.mjs).
//
// It forwards exactly what a producer used to pass straight to the
// dispatcher — `(name, payload, orgId)` — so receivers see the same `event`,
// the same `data` and the same tenant scoping. Like the direct call it never
// throws: a receiver that is down is logged by `dispatchWebhook`, not retried,
// so a delivery job always settles SUCCEEDED and one dead endpoint cannot make
// every other receiver of the event get it again. (Per-receiver retries and a
// delivery log are #1695.) A rerun — a container killed mid-job — POSTs the
// event again; receivers have always had to tolerate a repeat.

import { dispatchWebhook, WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks';
import type { SubscriberDefinition } from '../subscribers';

/** `dispatch` is injectable for the unit test only. */
export function createWebhookSubscriber(dispatch: typeof dispatchWebhook = dispatchWebhook): SubscriberDefinition {
  return {
    name: 'webhook',
    events: WEBHOOK_EVENTS,
    handle: (event) => dispatch(event.name as WebhookEvent, event.payload, event.orgId),
  };
}

export const webhookSubscriber = createWebhookSubscriber();
