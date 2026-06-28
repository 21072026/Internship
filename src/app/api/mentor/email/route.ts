import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { sendEmail } from '@/services/emailService';

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

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">${esc(body)
    .split('\n')
    .map((l) => `<p>${l || '&nbsp;'}</p>`)
    .join('')}</div>`;

  let sent = 0;
  for (const rel of relations) {
    try {
      await sendEmail({ to: rel.mentee.email, subject, html });
    } catch (e) {
      console.error('Mentor email failed for', rel.mentee.email, e);
    }
    await prisma.interactionLog.create({
      data: { relationId: rel.id, date: new Date(), type: 'Email', notes: `${subject} — ${body}` },
    });
    sent++;
  }

  return NextResponse.json({ sent });
}
