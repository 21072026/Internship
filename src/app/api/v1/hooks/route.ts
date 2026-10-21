import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiError, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import { MAX_HOOKS_PER_KEY, WEBHOOK_EVENTS } from '@/lib/webhooks';

// REST-hook subscriptions a connector manages for itself (#2002) — the
// platform side of "turn the Zap on / off". A subscription is OWNED by the key
// that made it: every query here carries `apiKeyId` AND `orgId` in its
// `where`, so a key never sees, counts or deletes another key's subscription,
// nor an admin-created one (apiKeyId null). Delivery is the ordinary webhook
// path (src/lib/webhooks.ts): signed, SSRF-checked again at delivery, and cut
// off once the owner key is revoked or expired.
const subscribeSchema = z
  .object({
    targetUrl: z.string().url().max(2048),
    event: z.enum(WEBHOOK_EVENTS),
  })
  .strict();

const hookSelect = { id: true, url: true, events: true, active: true, createdAt: true } as const;

function serializeHook(h: { id: string; url: string; events: unknown; active: boolean; createdAt: Date }) {
  const events = Array.isArray(h.events) ? (h.events as string[]) : [];
  return { id: h.id, targetUrl: h.url, event: events[0] ?? null, events, active: h.active, createdAt: h.createdAt.toISOString() };
}

// GET /api/v1/hooks — the calling key's own subscriptions, never their secrets.
export async function GET(request: Request) {
  return withApiKey(request, 'hooks:write', async (key) => {
    const hooks = await prisma.webhook.findMany({
      where: { apiKeyId: key.id, orgId: key.orgId },
      orderBy: { createdAt: 'asc' },
      select: hookSelect,
    });
    return apiOk(hooks.map(serializeHook));
  });
}

// POST /api/v1/hooks — subscribe a target URL to one event. The secret that
// signs every delivery (X-Signature, HMAC-SHA256 of the body) is returned
// ONCE, here. The URL passes the same SSRF guard as the admin form; a key holds
// at most MAX_HOOKS_PER_KEY subscriptions, because an unbounded subscribe
// endpoint is an amplifier for whatever it points at.
export async function POST(request: Request) {
  return withApiKey(request, 'hooks:write', (key) =>
    apiWrite(request, key, subscribeSchema, async (body) => {
      try {
        await assertPublicHttpsUrl(body.targetUrl);
      } catch (e) {
        if (!(e instanceof SsrfBlockedError)) throw e;
        return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
          errors: [{ path: 'targetUrl', code: 'unreachable_target', message: 'must be a public https URL' }],
        });
      }
      const held = await prisma.webhook.count({ where: { apiKeyId: key.id, orgId: key.orgId } });
      if (held >= MAX_HOOKS_PER_KEY) {
        return apiError(409, 'limit_reached', 'Subscription limit reached', `A key holds at most ${MAX_HOOKS_PER_KEY} subscriptions; delete one first.`, {
          limit: MAX_HOOKS_PER_KEY,
        });
      }
      const secret = randomBytes(24).toString('hex');
      const hook = await prisma.webhook.create({
        data: { url: body.targetUrl, events: [body.event], secret, orgId: key.orgId, apiKeyId: key.id, source: 'api' },
        select: hookSelect,
      });
      return writeOk(apiOk({ ...serializeHook(hook), secret }, undefined, undefined, { status: 201 }), {
        action: 'api.hook.subscribe',
        targetType: 'webhook',
        targetId: hook.id,
        detail: `${body.event} → ${new URL(body.targetUrl).host}`,
      });
    }),
  );
}
