// The SAML request store (#1955): node-saml's CacheProvider, backed by the
// SsoAuthRequest table #1929 introduced for OIDC — one request store, two
// protocols (`kind = 'saml'`). It is what makes InResponseTo correlation
// possible: until now `validateInResponseTo` was `never` because a stateless SP
// had nowhere to remember the AuthnRequest ID.
//
// SINGLE USE, ATOMICALLY. node-saml asks `getAsync(id)` up to twice while it
// validates ONE response (the Response's InResponseTo, then the
// SubjectConfirmationData's) and calls `removeAsync` afterwards. A read-then-
// delete would let two concurrent posts of the same response both pass the
// read. So the FIRST `getAsync` of an id spends the row with one conditional
// `updateMany` (usedAt: null, unexpired, this org), and the provider instance —
// created per request — remembers what it spent so the second `getAsync` of the
// same validation still answers. A replay arrives with a new instance and finds
// the row spent. `removeAsync` is therefore a no-op: the nightly housekeeping
// sweep deletes expired rows of both kinds.
//
// Server-only.

import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import { prisma } from '@/lib/prisma';
import { OIDC_REQUEST_TTL_MS } from '@/lib/ssoOidc';

export class SamlRequestStore implements CacheProvider {
  private readonly spent = new Map<string, string>();

  constructor(private readonly orgId: string) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await prisma.ssoAuthRequest.create({
      data: {
        orgId: this.orgId,
        kind: 'saml',
        state: key,
        expiresAt: new Date(Date.now() + OIDC_REQUEST_TTL_MS),
      },
    });
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    const remembered = this.spent.get(key);
    if (remembered) return remembered;
    const now = new Date();
    const won = await prisma.ssoAuthRequest.updateMany({
      where: { state: key, orgId: this.orgId, kind: 'saml', usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (won.count !== 1) return null;
    const row = await prisma.ssoAuthRequest.findUnique({ where: { state: key }, select: { createdAt: true } });
    // node-saml compares this instant against its own expiry window.
    const value = (row?.createdAt ?? now).toISOString();
    this.spent.set(key, value);
    return value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    return key;
  }
}
