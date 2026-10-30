import { prisma } from '@/lib/prisma';
import { ANY_LIVE_KEY, V1_RATE_LIMIT, withApiKey } from '@/lib/apiKey';
import { apiOk } from '@/lib/api/v1';
import { rateLimitState } from '@/lib/rateLimit';

// GET /api/v1/me (#2002) — the connector's auth test. Any live key may call it
// (ANY_LIVE_KEY, allowed for this route only by check-api-key-routes), and it
// answers only what the key already implies: its organisation, its scopes, its
// expiry and its limits. No user, no candidate, no other key — a stolen key
// learns nothing here it could not learn by trying it.
export async function GET(request: Request) {
  return withApiKey(request, ANY_LIVE_KEY, async (key) => {
    const [org, row] = await Promise.all([
      prisma.organization.findUnique({ where: { id: key.orgId }, select: { name: true } }),
      prisma.apiKey.findUnique({ where: { id: key.id }, select: { expiresAt: true } }),
    ]);
    const minute = rateLimitState('v1', `key:${key.id}`, V1_RATE_LIMIT);
    return apiOk({
      keyId: key.id,
      orgId: key.orgId,
      orgName: org?.name ?? null,
      scopes: key.scopes,
      expiresAt: row?.expiresAt ? row.expiresAt.toISOString() : null,
      rateLimit: { limit: minute.limit, remaining: minute.remaining, resetAt: new Date(minute.resetAt).toISOString() },
      quota: key.quotaPeriod && key.quotaLimit != null ? { period: key.quotaPeriod, limit: key.quotaLimit } : null,
    });
  }, { companyScoped: true, sourceScoped: true });
}
