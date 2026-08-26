import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { sendEmail } from '@/services/emailService';
import {
  NEWSLETTER_EMAIL_CATEGORY,
  canonicalNewsletterContent,
  normalizeNewsletterContent,
  type NewsletterAudience,
} from '@/lib/newsletter';
import {
  NEWSLETTER_IMAGE_CID,
  dispatchNewsletter,
  newsletterImageFilename,
  renderNewsletterFor,
} from '@/lib/newsletterDispatch';

const schema = z.object({
  // 'now' sends the issue to its audience. 'test' sends one copy to the admin
  // making the request and nothing else.
  mode: z.enum(['now', 'test']).default('now'),
});

/**
 * POST — send this issue now, or send yourself one test copy (#1469).
 *
 * The test send goes to the requesting admin's own registered address and to
 * nowhere else — deliberately not "an address you type", which is how a test
 * feature becomes a way to mail strangers from our From header. It writes no
 * NewsletterSend row either: a test is not a delivery to the audience, and
 * putting it in the record would make "who received issue X" wrong. EmailLog
 * still has it, which is the right place for "did this message leave".
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const issue = await prisma.newsletter.findUnique({
    where: { id },
    select: {
      id: true, status: true, audience: true, content: true,
      image: { select: { contentType: true, data: true } },
    },
  });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (parsed.data.mode === 'test') {
    const variants = normalizeNewsletterContent(issue.content);
    const canonical = canonicalNewsletterContent(variants);
    if (!canonical) return NextResponse.json({ error: 'This newsletter has no sendable content yet' }, { status: 400 });

    const me = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true, role: true, preferredLanguage: true },
    });
    if (!me?.email) return NextResponse.json({ error: 'Your account has no e-mail address' }, { status: 400 });

    const { subject, html } = await renderNewsletterFor({
      variants,
      canonical,
      audience: issue.audience as NewsletterAudience,
      // The admin's own role decides whether the mentor block shows, so the
      // test is a true preview of what THIS reader would get.
      role: me.role,
      preferredLanguage: me.preferredLanguage,
      imageSrc: issue.image ? `cid:${NEWSLETTER_IMAGE_CID}` : null,
      // No unsubscribe link: it is a test copy, not a subscription, and a
      // working unsubscribe here would let an admin silence themselves by
      // reflex while checking their own formatting.
      userId: null,
    });

    try {
      await sendEmail({
        to: me.email,
        subject: `[TEST] ${subject}`,
        html,
        category: NEWSLETTER_EMAIL_CATEGORY,
        attachments: issue.image
          ? [{
              filename: newsletterImageFilename(issue.image.contentType),
              content: Buffer.from(issue.image.data),
              contentType: issue.image.contentType,
              cid: NEWSLETTER_IMAGE_CID,
            }]
          : undefined,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Test send failed' }, { status: 502 });
    }

    await logActivity({
      action: 'newsletter.test_sent',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'newsletter',
      targetId: id,
    });
    return NextResponse.json({ ok: true, mode: 'test', to: me.email });
  }

  // Send now. A DRAFT is armed first — `dispatchNewsletter` only accepts
  // SCHEDULED/SENDING, which is what keeps the cron away from drafts.
  if (issue.status === 'DRAFT') {
    await prisma.newsletter.update({ where: { id }, data: { status: 'SCHEDULED', scheduledAt: new Date() } });
  } else if (issue.status !== 'SCHEDULED') {
    return NextResponse.json({ error: `A ${issue.status.toLowerCase()} newsletter cannot be sent again`, status: issue.status }, { status: 409 });
  }

  await logActivity({
    action: 'newsletter.send_now',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'newsletter',
    targetId: id,
  });

  const dispatch = await dispatchNewsletter(id);
  return NextResponse.json({ ok: !dispatch.noop, dispatch });
}
