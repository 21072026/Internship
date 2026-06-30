import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// Known webhook event types.
export const WEBHOOK_EVENTS = [
  'application.created',
  'pipeline.stage_change',
  'mentorship.created',
  'interaction.logged',
  'evaluation.added',
  'meeting.scheduled',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Fire-and-forget: POST a signed payload to every active webhook subscribed to
// the event. Never throws — delivery failures are logged, not propagated.
export async function dispatchWebhook(event: WebhookEvent, data: Record<string, unknown>) {
  let hooks;
  try {
    hooks = await prisma.webhook.findMany({ where: { active: true } });
  } catch (e) {
    logger.error('Webhook lookup failed', { error: String(e) });
    return;
  }
  const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });

  await Promise.all(
    hooks
      .filter((h) => Array.isArray(h.events) && (h.events as string[]).includes(event))
      .map(async (h) => {
        try {
          const signature = createHmac('sha256', h.secret).update(body).digest('hex');
          await fetch(h.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Signature': signature, 'X-Event': event },
            body,
          });
        } catch (e) {
          logger.warning('Webhook delivery failed', { url: h.url, event, error: String(e) });
        }
      })
  );
}
