import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { sendEmail } from '@/services/emailService';
import { notify } from '@/lib/notify';
import { replyAddress } from '@/lib/replyToken';
import { conversationForRelation } from '@/lib/conversations';
import { withTenantScope } from '@/lib/orgContext';
import { emailAllowed } from '@/lib/notificationPrefs';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { normalizeEmailVariants, canonicalEmail, resolveEmail } from '@/lib/localizedEmail';

const schema = z.object({
  relationIds: z.array(z.string().min(1)).min(1),
  // subject/body stay for the single-language path (API clients, older callers).
  // Since #1165 the composer may instead send `translations` — one complete
  // subject+body per language — and each mentee is sent the one they read.
  subject: z.string().max(TEXT_LIMITS.mentorEmailSubject).optional(),
  body: z.string().max(TEXT_LIMITS.mentorEmailBody).optional(),
  translations: z
    .record(z.string(), z.object({ subject: z.string(), body: z.string() }))
    .optional(),
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// POST — a mentor (or admin) emails one or more of their mentees. Each send is
// logged as an InteractionLog(Email) on the relation.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { relationIds } = parsed.data;
    const variants = normalizeEmailVariants(parsed.data.translations);
    // The canonical version is what a recipient falls back to when their own
    // language was not written — and what a single-language send uses outright.
    const canonical = canonicalEmail(variants, { subject: parsed.data.subject, body: parsed.data.body });
    if (!canonical) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: ['subject and body required'] } },
        { status: 400 }
      );
    }

    // A mentor may only email their own mentees; admins may email any.
    const where =
      session.user.role === 'ADMIN'
        ? { id: { in: relationIds } }
        : { id: { in: relationIds }, mentorId: session.user.id };
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      include: {
        mentee: {
          select: {
            id: true,
            email: true,
            fullName: true,
            emailNotifications: true,
            notificationPrefs: true,
            // Which version of the message this mentee is sent (#1165).
            preferredLanguage: true,
          },
        },
      },
    });

    // Template placeholders (e.g. "{name}") are filled per recipient with the
    // mentee's own name — otherwise the literal "{name}" is emailed out. A replacer
    // function avoids `$`-sequences in a name being interpreted by String.replace.
    const fill = (s: string, name: string) => s.replace(/\{name\}/g, () => name);

    let sent = 0;
    for (const rel of relations) {
      const name = rel.mentee.fullName;
      // Their language first, then the canonical version. Placeholders are
      // filled after resolving, so "{name}" keeps working in every language.
      const mine = resolveEmail(variants, canonical, rel.mentee.preferredLanguage);
      const personalSubject = fill(mine.subject, name);
      const personalBody = fill(mine.body, name);
      const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">${esc(personalBody)
        .split('\n')
        .map((l) => `<p>${l || '&nbsp;'}</p>`)
        .join('')}</div>`;
      if (emailAllowed(rel.mentee, 'messages')) {
        try {
          // Reply-To routes mentee replies back into this thread (inbound email).
          // The recipient is baked into the token so a reply still threads when
          // the mentee answers from a different address than their profile one.
          await sendEmail({ to: rel.mentee.email, subject: personalSubject, html, replyTo: replyAddress(rel.id, rel.mentee.id) });
        } catch (e) {
          console.error('Mentor email failed for', rel.mentee.email, e);
        }
      }
      await prisma.interactionLog.create({
        data: { relationId: rel.id, date: new Date(), type: 'Email', notes: `${personalSubject} — ${personalBody}` },
      });
      // Mirror the email into the pair's one chat thread (#1156) + notify the
      // mentee in-app. Stamped with both links: the conversation is where it is
      // read, the relation is what the digest and reply tokens work off.
      const conversation = await conversationForRelation(rel);
      await prisma.message.create({
        data: {
          relationId: rel.id,
          conversationId: conversation?.id ?? null,
          senderId: session.user.id,
          channel: 'EMAIL',
          body: `${personalSubject}\n\n${personalBody}`,
        },
      });
      const link = conversation ? `/messages/c/${conversation.id}` : `/messages/${rel.id}`;
      await notify(rel.menteeId, 'message', `New message from ${session.user.name ?? 'your mentor'}.`, link);
      sent++;
    }

    return NextResponse.json({ sent });
  });
}
