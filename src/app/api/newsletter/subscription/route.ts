import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emailAllowed } from '@/lib/notificationPrefs';
import { withNewsletterPref } from '@/lib/newsletter';

/**
 * PUT — turn the newsletter on or off for the signed-in reader (#1469).
 *
 * The session-authenticated twin of `/api/newsletter/unsubscribe`, which takes
 * a signed token because it is pressed from an e-mail with no login. This one
 * exists so the archive page can offer "send it to me again" without minting a
 * token for someone who is already signed in — and so neither surface has to
 * read, merge and re-write the whole `notificationPrefs` object the way
 * `PUT /api/profile` requires (that route replaces the column wholesale, which
 * is right for the account settings form and wrong for a single switch).
 */

const schema = z.object({ subscribed: z.boolean() });

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, emailNotifications: true, notificationPrefs: true },
  });
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const updated = await prisma.user.update({
    where: { id: me.id },
    data: { notificationPrefs: withNewsletterPref(me.notificationPrefs, parsed.data.subscribed) as Prisma.InputJsonValue },
    select: { emailNotifications: true, notificationPrefs: true },
  });

  await logActivity({
    action: parsed.data.subscribed ? 'newsletter.resubscribed' : 'newsletter.unsubscribed',
    actorId: me.id,
    actorEmail: me.email,
    targetType: 'user',
    targetId: me.id,
    detail: 'from the archive',
    request,
  });

  // Reports the EFFECTIVE state, not what was asked for: someone with the
  // master e-mail switch off is still not going to receive it, and saying
  // "done, it is on" would be a lie the archive would then display.
  return NextResponse.json({ ok: true, subscribed: emailAllowed(updated, 'newsletter') });
}
