import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { withNewsletterPref } from '@/lib/newsletter';
import { verifyUnsubscribeToken } from '@/lib/newsletterTokens';

/**
 * POST — stop (or resume) the newsletter, straight from the e-mail (#1469).
 *
 * No session required: the signed token IS the authorisation. Demanding a
 * password before someone can stop receiving mail is how you end up mailing
 * people who wanted out — and a reader who cannot unsubscribe in one press
 * reaches for the spam button instead, which damages the deliverability of
 * every message this app sends, password resets included.
 *
 * A deliberate POST rather than the GET the link points at: mail clients and
 * corporate link scanners prefetch every URL in a message, so a mutating GET
 * would unsubscribe people who never clicked. The page at
 * /newsletter/unsubscribe performs this call from the browser.
 *
 * Scope is exactly one switch: `notificationPrefs.newsletter`. It never touches
 * `emailNotifications` (the master switch) and never revokes a consent — losing
 * a meeting reminder because you tired of career tips would be a bug, not a
 * courtesy.
 */

const schema = z.object({
  token: z.string().min(1).max(512),
  // The same link is what someone uses to change their mind. Sent from the
  // confirmation screen and from the archive, not from the e-mail.
  resubscribe: z.boolean().optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'newsletter-unsubscribe', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const userId = verifyUnsubscribeToken(parsed.data.token);
  if (!userId) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, notificationPrefs: true },
  });
  // Already gone, or never there: the same answer either way. Someone pressing
  // "unsubscribe" twice should see that it worked, not an error — and the
  // response must not reveal whether an address is on file.
  if (!user) return NextResponse.json({ ok: true, subscribed: false });

  const subscribed = !!parsed.data.resubscribe;
  await prisma.user.update({
    where: { id: user.id },
    data: { notificationPrefs: withNewsletterPref(user.notificationPrefs, subscribed) as Prisma.InputJsonValue },
  });

  await logActivity({
    action: subscribed ? 'newsletter.resubscribed' : 'newsletter.unsubscribed',
    actorId: user.id,
    actorEmail: user.email,
    targetType: 'user',
    targetId: user.id,
    detail: 'via one-click link',
    request,
  });

  return NextResponse.json({ ok: true, subscribed });
}
