import { createHmac } from 'crypto';
import type { Prisma } from '@prisma/client';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { WEBHOOK_EVENTS } from '@/lib/events/catalog';

// A receiver that cannot answer in five seconds gets a retry later (#1695)
// rather than holding its delivery job open.
const WEBHOOK_TIMEOUT_MS = 5_000;

// The subscribable event names. Derived from the public entries of the
// versioned domain-event catalogue (#1691), which is where an event is added,
// documented and given a payload schema — in the same order as before, because
// the list is published in /api/v1/openapi.json. Re-exported here so the
// admin route, the v1 spec and the delivery job keep importing it from this file.
export { WEBHOOK_EVENTS };
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Subscriptions one API key may hold through POST /api/v1/hooks (#2002): an
// unbounded subscribe endpoint is an amplifier for whatever it points at.
export const MAX_HOOKS_PER_KEY = 25;

// Deliver one signed payload to one receiver. THROWS on a network failure or
// a URL the SSRF guard refuses; any HTTP answer, 4xx/5xx included, resolves
// with its status — the delivery job (src/lib/webhookDelivery.ts) records it
// and the test-ping route reports it. `event` is widened beyond WEBHOOK_EVENTS
// because 'ping' is deliverable but not subscribable: it deliberately stays out
// of the catalogue the checkboxes and the zod enum are built from.
//
// The body (`{ event, data, sentAt }`), the `X-Signature` (HMAC-SHA256 of
// exactly that body) and `X-Event` are a published contract (#1611) and stay
// byte-for-byte what they were; `X-Delivery-Id` (#1695) is additive.
export async function deliverToWebhook(
  hook: { url: string; secret: string },
  event: WebhookEvent | 'ping',
  data: Record<string, unknown>,
  opts: { deliveryId?: string; bodyLimit?: number } = {}
): Promise<{ status: number; ms: number; body: string }> {
  const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  // Re-checked at delivery, not just at registration (#893): DNS moves, and
  // rows created before the guard existed have never been checked at all.
  await assertPublicHttpsUrl(hook.url);
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Signature': signature, 'X-Event': event };
  if (opts.deliveryId) headers['X-Delivery-Id'] = opts.deliveryId;
  const startedAt = Date.now();
  const res = await fetch(hook.url, {
    method: 'POST',
    headers,
    body,
    // A redirect is never followed: the SSRF check above judged THIS url, and a
    // 3xx to http://127.0.0.1 would walk straight around it (#1695).
    redirect: 'manual',
    // Without this a single unresponsive endpoint held its delivery open
    // indefinitely (#895).
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  const text = await readBounded(res, opts.bodyLimit ?? 0);
  return { status: res.status, ms: Date.now() - startedAt, body: text };
}

// Read at most `limit` characters of a response and drop the rest unread — a
// receiver echoing a 2 MB error page must not be buffered whole.
async function readBounded(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  if (limit <= 0) {
    await res.body.cancel().catch(() => {});
    return '';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that breaks mid-read still leaves the status we already have.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

// Which subscriptions a tenant's event may reach: the active ones of that
// tenant (#2357) whose owner is still allowed to receive (#2002). An
// admin-created hook has no owner key; a connector's hook (POST /api/v1/hooks)
// stops the moment its key is revoked or expires — a revoked credential must
// not keep receiving the tenant's events through a subscription it left behind.
export function liveSubscriptionsWhere(orgId: string | null | undefined, now: Date = new Date()): Prisma.WebhookWhereInput {
  return {
    active: true,
    // Auto-disabled after a failure streak (#1695) until an admin re-enables it.
    disabledAt: null,
    orgId: orgId ?? null,
    OR: [{ apiKeyId: null }, { apiKey: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }],
  };
}
