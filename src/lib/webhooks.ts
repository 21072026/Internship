import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { WEBHOOK_EVENTS } from '@/lib/events/catalog';

// A receiver that cannot answer in five seconds is not worth blocking a request
// handler on; delivery is fire-and-forget anyway.
const WEBHOOK_TIMEOUT_MS = 5_000;

// The subscribable event names. Derived from the public entries of the
// versioned domain-event catalogue (#1691), which is where an event is added,
// documented and given a payload schema — in the same order as before, because
// the list is published in /api/v1/openapi.json. Re-exported here so the
// admin route, the v1 spec and the dispatcher keep importing it from this file.
export { WEBHOOK_EVENTS };
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Deliver one signed payload to one receiver. Unlike `dispatchWebhook` this
// THROWS on failure — the test-ping route reports the error back to the admin,
// so it must not be swallowed here. `event` is widened beyond WEBHOOK_EVENTS
// because 'ping' is deliverable but not subscribable: it deliberately stays out
// of the catalogue the checkboxes and the zod enum are built from.
export async function deliverToWebhook(
  hook: { url: string; secret: string },
  event: WebhookEvent | 'ping',
  data: Record<string, unknown>
): Promise<{ status: number; ms: number }> {
  const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  // Re-checked at delivery, not just at registration (#893): DNS moves, and
  // rows created before the guard existed have never been checked at all.
  await assertPublicHttpsUrl(hook.url);
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
  const startedAt = Date.now();
  const res = await fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature, 'X-Event': event },
    body,
    // Without this a single unresponsive endpoint held the request handler open
    // indefinitely — and these run under Promise.all, so the slowest target
    // stalled the whole batch (#895).
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  return { status: res.status, ms: Date.now() - startedAt };
}

// Fire-and-forget: POST a signed payload to every active webhook subscribed to
// the event. Never throws — delivery failures are logged, not propagated.
export async function dispatchWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>,
  orgId: string | null | undefined,
) {
  let hooks;
  try {
    // Scope to the acting tenant (#2357). Explicit rather than via the tenant
    // middleware: dispatch is fire-and-forget and often runs after the request
    // scope has unwound (and the middleware is advisory until MT_ENFORCE_ISOLATION
    // is on), so one tenant's event must never fan out to another's endpoint.
    // A null orgId (a legacy/system caller) matches only the legacy null-org
    // webhooks, which the deploy backfill moves to the default org.
    hooks = await prisma.webhook.findMany({ where: { active: true, orgId: orgId ?? null } });
  } catch (e) {
    logger.error('Webhook lookup failed', { error: String(e) });
    return;
  }

  await Promise.all(
    hooks
      .filter((h) => Array.isArray(h.events) && (h.events as string[]).includes(event))
      .map(async (h) => {
        try {
          await deliverToWebhook(h, event, data);
        } catch (e) {
          logger.warning('Webhook delivery failed', { url: h.url, event, error: String(e) });
        }
      })
  );
}
