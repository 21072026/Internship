import { createHash, randomBytes } from 'crypto';
import { hostnameOf, servedHosts } from '@/lib/servedHosts';
import { prisma } from '@/lib/prisma';
import { isEmbedSessionEnabled } from '@/lib/embedSession';

// The Teams tab sign-in, server side (#1954, docs/teams-tab-sso.md). The token
// is verified in teamsSsoToken.ts; here it only names a CONFIRMED identity in
// an ENABLED workspace of the tenant it claims, and that identity's person gets
// a 60-second, single-use, hashed grant. No provisioning, no matching by
// e-mail, no account created: an unknown or unconfirmed member is `link`.

export const CHAT_LOGIN_GRANT_TTL_MS = 60_000;

export function isTeamsSsoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isEmbedSessionEnabled(env);
}

export const hashGrant = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * Was this request sent by one of our own pages? (#1954, login-CSRF guard.)
 * The Teams tab is our own origin inside the iframe, so a browser POST from it
 * carries an Origin (or at least a Referer) on a served host; anything else —
 * no header, another site — is refused before the body is read.
 */
export function fromServedOrigin(request: Request): boolean {
  const raw = request.headers.get('origin') ?? request.headers.get('referer');
  if (!raw || raw === 'null') return false;
  let host: string | null;
  try {
    host = hostnameOf(new URL(raw).host);
  } catch {
    return false;
  }
  return !!host && servedHosts().has(host);
}

export type TeamsLoginResolution =
  | { kind: 'grant'; grant: string; nonce: string }
  | { kind: 'link' }
  | { kind: 'unknown_tenant' };

/** (tid, oid) → a grant for that person, minted for `host`; or why not. */
export async function resolveTeamsLogin(tid: string, oid: string, host: string): Promise<TeamsLoginResolution> {
  const ws = await prisma.chatWorkspace.findFirst({
    where: { platform: 'TEAMS', externalId: { in: [tid, tid.toUpperCase()] }, enabled: true },
    select: { id: true, orgId: true },
  });
  if (!ws) return { kind: 'unknown_tenant' };
  const identity = await prisma.chatIdentity.findUnique({
    where: { workspaceId_externalUserId: { workspaceId: ws.id, externalUserId: oid } },
    select: { id: true, verifiedAt: true, user: { select: { id: true, orgId: true } } },
  });
  // Confirmed by the person themselves (#1937), and of the workspace's org.
  if (!identity?.verifiedAt || !identity.user || (ws.orgId && identity.user.orgId !== ws.orgId)) return { kind: 'link' };
  const grant = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  await prisma.chatLoginGrant.create({
    data: {
      tokenHash: hashGrant(grant),
      nonceHash: hashGrant(nonce),
      userId: identity.user.id,
      identityId: identity.id,
      host: host.slice(0, 255),
      expiresAt: new Date(Date.now() + CHAT_LOGIN_GRANT_TTL_MS),
    },
  });
  return { kind: 'grant', grant, nonce };
}
