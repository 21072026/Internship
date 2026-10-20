import { createHmac } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';

// A receiver that cannot answer in five seconds is not worth blocking a request
// handler on; delivery is fire-and-forget anyway.
const WEBHOOK_TIMEOUT_MS = 5_000;

// Known webhook event types.
export const WEBHOOK_EVENTS = [
  'application.created',
  'pipeline.stage_change',
  'mentorship.created',
  'interaction.logged',
  'evaluation.added',
  'meeting.scheduled',
  // A meeting moved, or was called off (#1980). An integration mirroring the
  // calendar needs both, or its copy keeps the time nobody is coming at.
  'meeting.rescheduled',
  'meeting.cancelled',
  // Every assigned interviewer has submitted (or an admin closed the panel):
  // the scores are now comparable (#824).
  'interview_panel.completed',
  // A closed panel's decision: ADVANCE | REJECT | OFFER (#1846). Registered, not yet dispatched.
  'interview_panel.outcome',
  // An approved interview request got a real meeting / was called off (#1844).
  // Registered, not yet dispatched: see scripts/check-events.mjs.
  'interview_request.scheduled',
  'interview_request.cancelled',
  // An offer was decided by the candidate (#1854), and an acceptance took the
  // last seat of its requisition. Registered, not yet raised: they leave
  // through `emit()` (#1693) once it exists — see the note in
  // src/app/api/offers/[id]/route.ts. `requisition.filled` is meant to fire
  // once, on the acceptance that made `filled` reach `openings`.
  'offer.accepted',
  'offer.declined',
  'requisition.filled',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Subscriptions one API key may hold through POST /api/v1/hooks (#2002): an
// unbounded subscribe endpoint is an amplifier for whatever it points at.
export const MAX_HOOKS_PER_KEY = 25;

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

// Which subscriptions a tenant's event may reach: the active ones of that
// tenant (#2357) whose owner is still allowed to receive (#2002). An
// admin-created hook has no owner key; a connector's hook (POST /api/v1/hooks)
// stops the moment its key is revoked or expires — a revoked credential must
// not keep receiving the tenant's events through a subscription it left behind.
export function liveSubscriptionsWhere(orgId: string | null | undefined, now: Date = new Date()): Prisma.WebhookWhereInput {
  return {
    active: true,
    orgId: orgId ?? null,
    OR: [{ apiKeyId: null }, { apiKey: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }],
  };
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
    hooks = await prisma.webhook.findMany({ where: liveSubscriptionsWhere(orgId) });
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
