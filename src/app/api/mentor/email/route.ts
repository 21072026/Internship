import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { sendEmail } from '@/services/emailService';
import { notify } from '@/lib/notify';
import { replyAddress } from '@/lib/replyToken';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({
  relationIds: z.array(z.string().min(1)).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
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
    const { relationIds, subject, body } = parsed.data;

    // A mentor may only email their own mentees; admins may email any.
    const where =
      session.user.role === 'ADMIN'
        ? { id: { in: relationIds } }
        : { id: { in: relationIds }, mentorId: session.user.id };
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      include: { mentee: { select: { email: true, fullName: true } } },
    });

    // Template placeholders (e.g. "{name}") are filled per recipient with the
    // mentee's own name — otherwise the literal "{name}" is emailed out. A replacer
    // function avoids `$`-sequences in a name being interpreted by String.replace.
    const fill = (s: string, name: string) => s.replace(/\{name\}/g, () => name);

    let sent = 0;
    for (const rel of relations) {
      const name = rel.mentee.fullName;
      const personalSubject = fill(subject, name);
      const personalBody = fill(body, name);
      const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">${esc(personalBody)
        .split('\n')
        .map((l) => `<p>${l || '&nbsp;'}</p>`)
        .join('')}</div>`;
      try {
        // Reply-To routes mentee replies back into this thread (inbound email).
        await sendEmail({ to: rel.mentee.email, subject: personalSubject, html, replyTo: replyAddress(rel.id) });
      } catch (e) {
        console.error('Mentor email failed for', rel.mentee.email, e);
      }
      await prisma.interactionLog.create({
        data: { relationId: rel.id, date: new Date(), type: 'Email', notes: `${personalSubject} — ${personalBody}` },
      });
      // Mirror the email into the conversation thread + notify the mentee in-app.
      await prisma.message.create({
        data: { relationId: rel.id, senderId: session.user.id, channel: 'EMAIL', body: `${personalSubject}\n\n${personalBody}` },
      });
      await notify(rel.menteeId, 'message', `New message from ${session.user.name ?? 'your mentor'}.`, `/messages/${rel.id}`);
      sent++;
    }

    return NextResponse.json({ sent });
  });
}
