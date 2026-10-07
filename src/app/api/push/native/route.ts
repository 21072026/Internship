import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { hostnameOf, isServedHost } from '@/lib/servedHosts';
import { EXPO_TOKEN_RE } from '@/lib/expoPushRules';

/**
 * The native app's push token (#2775, docs/mobile-push.md) — the mobile twin of
 * /api/push/subscribe. Both verbs need a session: the app calls them with the
 * cookie jar of the product it is signed in to.
 *
 * The row is keyed by (token, host). The host is the served hostname this
 * request arrived on — the product the app is signed in to — never a value the
 * body names: it decides which product a tap opens, and a session is only valid
 * on its own world's host (docs/worlds.md), so it is also the account's world.
 */

const tokenField = z.string().max(200).regex(EXPO_TOKEN_RE);

const registerSchema = z.object({
  token: tokenField,
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().max(32).optional(),
  // true: the app is re-confirming a token it registered earlier (every
  // launch). Then only an EXISTING row of this account is refreshed — a row the
  // person revoked on /account, or that sign-out-everywhere dropped, stays gone.
  refresh: z.boolean().optional(),
});

const unregisterSchema = z.object({ token: tokenField });

function requestHost(request: Request): string | null {
  const header = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  return isServedHost(header) ? hostnameOf(header) : null;
}

/**
 * POST — register or refresh this install's token for the signed-in account.
 * Answers `{ registered }`: false only for a `refresh` that found nothing, which
 * tells the app the server no longer wants this phone (it then stays quiet until
 * the next sign-in).
 */
export async function POST(request: Request) {
  // An app registers once per sign-in and refreshes once per launch.
  const limited = enforceRateLimit(request, 'push-native', { limit: 20, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const host = requestHost(request);
  if (!host) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

  const { token, platform, appVersion, refresh } = parsed.data;
  const userId = session.user.id;

  if (refresh) {
    const { count } = await prisma.nativePushToken.updateMany({
      where: { token, host, userId },
      data: { lastSeenAt: new Date(), appVersion: appVersion ?? null, platform },
    });
    return NextResponse.json({ registered: count > 0 });
  }

  // Within one product a phone holds one account, so a sign-in by somebody
  // else on the same phone takes the row over (PushSubscription's endpoint rule).
  await prisma.nativePushToken.upsert({
    where: { token_host: { token, host } },
    create: { userId, token, host, platform, appVersion: appVersion ?? null },
    update: { userId, platform, appVersion: appVersion ?? null, failureCount: 0, lastSeenAt: new Date() },
  });
  return NextResponse.json({ registered: true });
}

/**
 * DELETE — the app signing out. Scoped to the caller's own row on this host, so
 * knowing another person's token silences nobody, and idempotent: the app
 * calls it on every sign-out whether or not it ever registered.
 */
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = unregisterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const host = requestHost(request);
  if (!host) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

  const { count } = await prisma.nativePushToken.deleteMany({
    where: { token: parsed.data.token, host, userId: session.user.id },
  });
  return NextResponse.json({ ok: true, removed: count });
}
