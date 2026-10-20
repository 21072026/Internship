import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SCOPE_ENTITLEMENT, apiKeyStatus, parseScopes, type ApiScope } from '@/lib/apiScopes';
import { entitled } from '@/lib/entitlements';
import { assertApiKeyRequestContext, runAsApiKeyRequest, runWithApiKeyOrg } from '@/lib/orgContext';
import { clientIp, enforceRateLimit, rateLimitState } from '@/lib/rateLimit';
import { consumeApiKeyQuota } from '@/lib/apiKeyQuota';
import { bindingLimit, rateLimitHeaders, type LimitState } from '@/lib/apiKeyQuotaRules';
import { apiError } from '@/lib/api/v1';

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateApiKey(): { raw: string; hash: string } {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  return { raw, hash: hashApiKey(raw) };
}

// What a presented key turns out to be. `orgId` is nullable here and NOT in
// ApiKeyContext below, because "which organisation is this?" is a question the
// door answers — a key that cannot answer it is refused, never served.
export interface ApiKeyIdentity {
  id: string;
  orgId: string | null;
  scopes: string[];
  /** The period allowance (#2010); both null = none. */
  quotaPeriod: string | null;
  quotaLimit: number | null;
}

// The identity a handler receives: authenticated, in scope, and bound to one
// organisation.
export interface ApiKeyContext extends ApiKeyIdentity {
  orgId: string;
}

// Shared by every /api/v1 route: the IP brake for requests without a working
// key and the per-key allowance behind it use the same bucket and numbers.
export const V1_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

// `lastUsedAt` is a "when did this integration last call?" fact, not a meter:
// stamping it at most once a minute keeps the door from writing a row per
// request (the quota's own counter is batched for the same reason, #2010).
const LAST_USED_RESOLUTION_MS = 60 * 1000;

// Authenticate a request via "Authorization: Bearer <key>". Returns the key's
// identity when it is valid (and stamps lastUsedAt), else null.
//
// #1545 recorded a key's expiry, revocation and scopes; #1546 is where they are
// CHECKED. A revoked or expired key is indistinguishable from an unknown one
// here on purpose — all three are a 401, and saying which would tell whoever
// holds a stolen key what became of it.
//
// Not for direct use by routes: call withApiKey() instead. Doing so outside it
// throws in development (see assertApiKeyRequestContext), because a
// key-authenticated request that never binds an org reads every tenant.
export async function authenticateApiKey(request: Request): Promise<ApiKeyIdentity | null> {
  assertApiKeyRequestContext('authenticateApiKey()');
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = await prisma.apiKey.findUnique({
    where: { hashedKey: hashApiKey(m[1].trim()) },
    select: { id: true, orgId: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, quotaPeriod: true, quotaLimit: true },
  });
  if (!key) return null;
  // Revocation and expiry are one derived status (lib/apiScopes.ts) so the door
  // and the admin list can never disagree about what a key is.
  if (apiKeyStatus(key) !== 'active') return null;
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { id: key.id, orgId: key.orgId, scopes: parseScopes(key.scopes), quotaPeriod: key.quotaPeriod, quotaLimit: key.quotaLimit };
}

// 403, never a filtered 200: a key asking for something it was not granted is a
// misconfigured integration, and an empty list would hide that from whoever has
// to fix it.
export function requireApiScope(key: ApiKeyIdentity, scope: ApiScope): NextResponse | null {
  if (key.scopes.includes(scope)) return null;
  return apiError(403, 'insufficient_scope', 'Insufficient scope', `This API key does not hold the required scope: ${scope}`, { scope });
}

/**
 * The single door of the public API (#1546).
 *
 * Every /api/v1 route goes through here, so expiry, revocation, scope, tenant
 * binding, the rate limits and the period quota are decided in ONE place
 * instead of being re-implemented — or forgotten — per route. The handler only
 * ever runs for a live, in-scope key that belongs to exactly one organisation,
 * and it runs inside that organisation's tenant context.
 *
 * Fails closed, in this order:
 *   - an address already over the per-minute limit with failed/absent keys → 429 `rate_limited`
 *   - no / unknown / expired / revoked key → 401
 *   - the key's own per-minute window is spent → 429 `rate_limited`
 *   - key does not hold `scope`            → 403
 *   - key resolves to no organisation      → 403, never an unscoped read (the
 *     #831 "allowlist by omission" lesson: an unlisted case is rejected)
 *   - the org's plan lacks the feature the scope belongs to (#1744) → 403
 *     `feature_locked`
 *   - the key's period allowance is spent (#2010) → 429 `quota_exceeded`, with
 *     the reset instant
 *
 * Per-minute keying (#2010 on top of #1546): a request with a WORKING key
 * spends only that key's window, so two integrations behind one NAT no longer
 * share a budget. The IP window brakes everything else — requests without a
 * key and requests whose key fails — and is checked before the key lookup, so
 * a flood of garbage keys from one address stops costing database round trips
 * once that address is over its limit.
 *
 * Every response carries `RateLimit-Limit` / `-Remaining` / `-Reset` for the
 * limit closest to exhaustion, so a client can slow down before it is refused.
 */
export async function withApiKey(
  request: Request,
  scope: ApiScope,
  handler: (key: ApiKeyContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const limits: { minute?: LimitState; quota?: LimitState | null } = {};
  const response = await door(request, scope, handler, limits);
  const binding = bindingLimit([limits.minute, limits.quota]);
  if (binding) for (const [name, value] of Object.entries(rateLimitHeaders(binding))) response.headers.set(name, value);
  return response;
}

/** A per-minute refusal, typed so a client can tell it from `quota_exceeded`. */
function rateLimited(limited: NextResponse): NextResponse {
  return apiError(429, 'rate_limited', 'Too many requests', 'Too many requests. Please try again later.', {
    headers: { 'Retry-After': limited.headers.get('Retry-After') ?? '60' },
  });
}

// One body for every 401: unknown, expired and revoked are deliberately alike.
function invalidKey(): NextResponse {
  return apiError(401, 'invalid_api_key', 'Invalid or missing API key');
}

async function door(
  request: Request,
  scope: ApiScope,
  handler: (key: ApiKeyContext) => Promise<NextResponse>,
  limits: { minute?: LimitState; quota?: LimitState | null },
): Promise<NextResponse> {
  const ip = clientIp(request);
  const presentsKey = /^Bearer\s+\S/i.test(request.headers.get('authorization') || '');
  const ipState = () => rateLimitState('v1', ip, V1_RATE_LIMIT);

  // No key at all: the IP window, counted, exactly as before.
  if (!presentsKey) {
    const ipLimited = enforceRateLimit(request, 'v1', V1_RATE_LIMIT);
    limits.minute = ipState();
    if (ipLimited) return rateLimited(ipLimited);
    return invalidKey();
  }
  // A key is presented: an address already over its limit (from failed keys)
  // is refused before the lookup costs anything.
  if (ipState().remaining <= 0) {
    const ipLimited = enforceRateLimit(request, 'v1', V1_RATE_LIMIT);
    limits.minute = ipState();
    if (ipLimited) return rateLimited(ipLimited);
  }

  return runAsApiKeyRequest(async () => {
    const key = await authenticateApiKey(request);
    if (!key) {
      // A failed key spends the address's window — the brute-force brake.
      const ipLimited = enforceRateLimit(request, 'v1', V1_RATE_LIMIT);
      limits.minute = ipState();
      if (ipLimited) return rateLimited(ipLimited);
      return invalidKey();
    }

    // The key's own window on the SAME limiter and the same bucket (#2028's
    // additive `subject` option, #1546's keying): not a second limiter and
    // not a second store.
    const keyLimited = enforceRateLimit(request, 'v1', { ...V1_RATE_LIMIT, subject: `key:${key.id}` });
    limits.minute = rateLimitState('v1', `key:${key.id}`, V1_RATE_LIMIT);
    if (keyLimited) return rateLimited(keyLimited);

    const outOfScope = requireApiScope(key, scope);
    if (outOfScope) return outOfScope;

    const orgId = key.orgId;
    if (!orgId) {
      return apiError(403, 'org_unbound', 'This API key is not bound to an organization');
    }

    return runWithApiKeyOrg(orgId, async () => {
      // The plan (#1744), checked once the org is bound — there is nothing to
      // check an entitlement against before it, and OrgEntitlement is a tenant
      // model the unbound guard above would refuse. Keyed to the SCOPE the
      // route asks for (SCOPE_ENTITLEMENT), so every route that reads the
      // public API is gated without having to remember to be. A key whose org
      // lost the feature is not revoked: it answers 403 naming the feature,
      // which tells an integration partner what happened where a 401 would only
      // say "wrong key".
      const feature = SCOPE_ENTITLEMENT[scope];
      if (feature && !(await entitled(orgId, feature))) {
        return apiError(403, 'feature_locked', 'Your plan does not include API access', undefined, { code: 'feature_locked', feature });
      }
      // The period allowance (#2010), last: a request refused for its scope,
      // its org or its plan never spends any of it. Counted in a batched
      // tally (src/lib/apiKeyQuota.ts), never one write per request.
      const quota = await consumeApiKeyQuota(key);
      limits.quota = quota.state;
      if (!quota.ok) {
        return apiError(429, 'quota_exceeded', 'This API key has used its request allowance for the period', undefined, {
          resetAt: quota.resetAt.toISOString(),
          headers: { 'Retry-After': String(Math.max(1, Math.ceil((quota.resetAt.getTime() - Date.now()) / 1000))) },
        });
      }
      return handler({ ...key, orgId });
    });
  });
}
