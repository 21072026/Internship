// The webhook subscriber (#1693, #1695): a public domain event → one
// `webhook.deliver` job per live subscription of the event's tenant. The
// delivery itself — signing, the SSRF re-check, the attempt row, retry and
// auto-disable — is src/lib/webhookDelivery.ts.
//
// A rerun of this fan-out (a container killed mid-job) enqueues nothing twice:
// each delivery job is keyed `whk:<eventId>:<webhookId>`. Fanning out instead
// of posting here is what keeps one hanging receiver from delaying another
// partner's delivery of the same event.

import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import type { DeliveredEvent, SubscriberDefinition } from '../subscribers';

type FanOut = (event: DeliveredEvent) => Promise<unknown>;

/** `fanOut` is injectable for the unit test only. */
export function createWebhookSubscriber(fanOut?: FanOut): SubscriberDefinition {
  return {
    name: 'webhook',
    events: WEBHOOK_EVENTS,
    handle: async (event) => {
      const run = fanOut ?? (await import('@/lib/webhookDelivery')).fanOutWebhookEvent;
      await run(event);
    },
  };
}

export const webhookSubscriber = createWebhookSubscriber();
