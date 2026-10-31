import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestOrigin } from '@/lib/servedHosts';
import { createLoginLinkToken } from '@/lib/magicLink';
import { logActivity } from '@/lib/activity';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSocialAccount, openConsentTicket, SOCIAL_CONSENT_COOKIE } from '@/lib/socialSignIn';

// Social sign-up's consent step (#1962): the account a new social identity
// would create is created only here, after the person accepted the same
// privacy notice and terms the register form asks for. The verified identity
// arrives in the sealed, browser-bound cookie the callback set; no body field
// can name an identity. No consent → 400 and nothing is created.
//
// Pre-auth by nature (route-auth baseline): the caller is authenticated by the
// sealed ticket, which only the callback mints after verifying the provider's
// ID token. The session is still minted by the `magic` provider.

const schema = z.object({ consent: z.literal(true), privacyVersion: z.string().max(32).optional() }).strict();

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, 'social-consent', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Consent is required', code: 'consent_required' }, { status: 400 });
  const cookie = req.headers.get('cookie') ?? '';
  const raw = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SOCIAL_CONSENT_COOKIE}=`))?.slice(SOCIAL_CONSENT_COOKIE.length + 1);
  const ticket = openConsentTicket(raw ? decodeURIComponent(raw) : null);
  if (!ticket) return NextResponse.json({ error: 'This sign-up has expired. Start again.', code: 'ticket_expired' }, { status: 400 });

  const outcome = await createSocialAccount(ticket, parsed.data.privacyVersion ?? PRIVACY_POLICY_VERSION);
  const origin = requestOrigin((n) => req.headers.get(n));
  const done = (body: Record<string, unknown>, status = 200) => {
    const res = NextResponse.json(body, { status });
    res.cookies.delete({ name: SOCIAL_CONSENT_COOKIE, path: '/api/auth/social' });
    return res;
  };
  if (outcome.kind === 'refuse') {
    await logActivity({ action: 'auth.social_failed', level: 'warning', detail: `${ticket.provider}: consent ${outcome.reason}` });
    return done({ error: 'Refused', code: outcome.reason }, 409);
  }
  if (outcome.kind === 'pending') return done({ redirect: `${origin}/auth/signin?error=social_pending_approval` });
  if (outcome.kind !== 'sign_in') return done({ error: 'Refused', code: 'unavailable' }, 409);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const token = await createLoginLinkToken(outcome.userId, ip);
  return done({ redirect: `${origin}/auth/magic/complete?token=${encodeURIComponent(token)}` });
}
