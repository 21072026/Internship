import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/rateLimit';
import { clientIp } from '@/lib/clientIp';
import { platformFromSlug } from '@/lib/chat/config';
import { withRequestScope } from '@/lib/requestContext';
import { hostnameOf } from '@/lib/servedHosts';
import { verifyTeamsSsoToken } from '@/lib/chat/teamsSsoToken';
import { isTeamsSsoEnabled, resolveTeamsLogin } from '@/lib/chat/teamsSso';

// POST — the Teams tab trades its Entra token for a single-use grant (#1954,
// docs/teams-tab-sso.md). 404 unless Teams SSO is configured, before the body
// is read. Every refusal is the same opaque 401; only a reason code is logged,
// never the token. An unknown or unconfirmed member is `{ link: true }` — no
// grant, no account.
const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const PER_IP = { limit: 20, windowMs: 60_000 };
const PER_TENANT = { limit: 120, windowMs: 60_000 };

export async function POST(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return withRequestScope(request, async () => {
    if (platformFromSlug((await params).platform) !== 'TEAMS' || !isTeamsSsoEnabled()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!rateLimit(`teams-sso-ip:${clientIp(request)}`, PER_IP).ok) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    let token: unknown;
    try {
      token = ((await request.json()) as { token?: unknown })?.token;
    } catch {
      return UNAUTHORIZED();
    }
    if (typeof token !== 'string') return UNAUTHORIZED();
    const host = hostnameOf(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
    const verified = await verifyTeamsSsoToken(token, {
      clientId: process.env.TEAMS_SSO_CLIENT_ID as string,
      host,
      jwksUrl: process.env.TEAMS_SSO_JWKS_URL,
    });
    if (!verified.ok) {
      logger.warning('teams sso refused', { reason: verified.reason });
      return UNAUTHORIZED();
    }
    if (!rateLimit(`teams-sso-tenant:${verified.tid}`, PER_TENANT).ok) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (!host) return UNAUTHORIZED();
    const resolved = await resolveTeamsLogin(verified.tid, verified.oid, host);
    if (resolved.kind === 'unknown_tenant') {
      logger.warning('teams sso refused', { reason: 'unknown_tenant' });
      return UNAUTHORIZED();
    }
    if (resolved.kind === 'link') return NextResponse.json({ link: true });
    return NextResponse.json({ grant: resolved.grant });
  });
}
