import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiKeyStatus, parseScopes, type ApiScope } from '@/lib/apiScopes';
import { assertApiKeyRequestContext, runAsApiKeyRequest, runWithApiKeyOrg } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';

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
}

// The identity a handler receives: authenticated, in scope, and bound to one
// organisation.
export interface ApiKeyContext extends ApiKeyIdentity {
  orgId: string;
}

// Shared by every /api/v1 route: the IP brake in front of the door and the
// per-key allowance behind it use the same bucket and the same numbers.
const V1_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

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
    select: { id: true, orgId: true, scopes: true, expiresAt: true, revokedAt: true },
  });
  if (!key) return null;
  // Revocation and expiry are one derived status (lib/apiScopes.ts) so the door
  // and the admin list can never disagree about what a key is.
  if (apiKeyStatus(key) !== 'active') return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { id: key.id, orgId: key.orgId, scopes: parseScopes(key.scopes) };
}

// 403, never a filtered 200: a key asking for something it was not granted is a
// misconfigured integration, and an empty list would hide that from whoever has
// to fix it.
export function requireApiScope(key: ApiKeyIdentity, scope: ApiScope): NextResponse | null {
  if (key.scopes.includes(scope)) return null;
  return NextResponse.json(
    { error: `This API key does not hold the required scope: ${scope}` },
    { status: 403 },
  );
}

/**
 * The single door of the public API (#1546).
 *
 * Every /api/v1 route goes through here, so expiry, revocation, scope, tenant
 * binding and the rate limits are decided in ONE place instead of being
 * re-implemented — or forgotten — per route. The handler only ever runs for a
 * live, in-scope key that belongs to exactly one organisation, and it runs
 * inside that organisation's tenant context.
 *
 * Fails closed, in this order:
 *   - no / unknown / expired / revoked key → 401
 *   - key does not hold `scope`            → 403
 *   - key resolves to no organisation      → 403, never an unscoped read (the
 *     #831 "allowlist by omission" lesson: an unlisted case is rejected)
 */
export async function withApiKey(
  request: Request,
  scope: ApiScope,
  handler: (key: ApiKeyContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  // The IP brake stays exactly where it was: in front of everything, so an
  // anonymous flood is stopped before it costs a database round trip.
  const ipLimited = enforceRateLimit(request, 'v1', V1_RATE_LIMIT);
  if (ipLimited) return ipLimited;

  return runAsApiKeyRequest(async () => {
    const key = await authenticateApiKey(request);
    if (!key) return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 });

    // A second dimension on the SAME limiter and the same bucket (#2028's
    // additive `subject` option), not a second limiter and not a second store:
    // one integration hammering the API now spends its own allowance instead of
    // everyone else's behind the same address. The IP limit above is unchanged.
    const keyLimited = enforceRateLimit(request, 'v1', { ...V1_RATE_LIMIT, subject: `key:${key.id}` });
    if (keyLimited) return keyLimited;

    const outOfScope = requireApiScope(key, scope);
    if (outOfScope) return outOfScope;

    const orgId = key.orgId;
    if (!orgId) {
      return NextResponse.json(
        { error: 'This API key is not bound to an organization' },
        { status: 403 },
      );
    }

    return runWithApiKeyOrg(orgId, () => handler({ ...key, orgId }));
  });
}
