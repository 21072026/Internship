import { NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import type { JWT } from 'next-auth/jwt';
import { authOptions, redeemChatLoginGrant } from '@/lib/auth';
import { platformFromSlug } from '@/lib/chat/config';
import { withRequestScope } from '@/lib/requestContext';
import { hostnameOf } from '@/lib/servedHosts';
import { isTeamsSsoEnabled } from '@/lib/chat/teamsSso';
import { EMBED_SESSION_MAX_AGE_S, embedSetCookie, secureCookies } from '@/lib/embedSession';
import { roleHome } from '@/lib/roleHome';

// POST — the Teams tab redeems its grant for the embed session (#1954,
// docs/teams-tab-sso.md § decision B). 404 unless Teams SSO is configured.
// redeemChatLoginGrant() is the sign-in door (every refusal the other doors
// have, the second factor before the spend); the claims come from authOptions'
// own jwt callback — the one place they are decided — and the session goes
// into the EMBED cookie (Partitioned, SameSite=None, eight hours), never into
// NextAuth's.
const KNOWN = new Set(['2FA_REQUIRED', 'EMAIL_NOT_VERIFIED', 'ACCOUNT_PENDING_APPROVAL', 'SSO_REQUIRED']);

export async function POST(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return withRequestScope(request, async () => {
    if (platformFromSlug((await params).platform) !== 'TEAMS' || !isTeamsSsoEnabled()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    let body: { grant?: unknown; totp?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: 'Unauthorized', code: 'invalid' }, { status: 401 });
    }
    if (typeof body?.grant !== 'string' || body.grant.length > 128) return NextResponse.json({ error: 'Unauthorized', code: 'invalid' }, { status: 401 });
    const host = hostnameOf(request.headers.get('x-forwarded-host') ?? request.headers.get('host')) ?? '';
    let user: Awaited<ReturnType<typeof redeemChatLoginGrant>>;
    try {
      user = await redeemChatLoginGrant(body.grant, typeof body.totp === 'string' ? body.totp : undefined, {
        headers: Object.fromEntries(request.headers.entries()),
        host,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      const code = KNOWN.has(message) ? message : message.startsWith('WRONG_WORLD') ? 'WRONG_WORLD' : 'invalid';
      return NextResponse.json({ error: 'Unauthorized', code }, { status: 401 });
    }

    const jwt = authOptions.callbacks!.jwt! as unknown as (args: Record<string, unknown>) => Promise<JWT>;
    const token = await jwt({
      token: { name: user.name, email: user.email, sub: user.id },
      user,
      account: { provider: 'chat', type: 'credentials', providerAccountId: user.id },
      trigger: 'signIn',
    });
    const value = await encode({ token, secret: process.env.NEXTAUTH_SECRET as string, maxAge: EMBED_SESSION_MAX_AGE_S });
    const res = NextResponse.json({ ok: true, home: roleHome(user.role) });
    res.headers.append('set-cookie', embedSetCookie(value, secureCookies()));
    return res;
  });
}
