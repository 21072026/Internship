import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import { notify } from '@/lib/notify';

// GET ?relationId= — questions for a thread (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const relationId = new URL(request.url).searchParams.get('relationId') || '';
  const rel = await getThreadIfAllowed(session.user, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const questions = await prisma.mentorQuestion.findMany({ where: { relationId }, orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ questions });
}

const schema = z.object({ relationId: z.string().min(1), question: z.string().min(1).max(2000) });

// POST — a participant (typically the mentee) asks a question.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const q = await prisma.mentorQuestion.create({
    data: { relationId: rel.id, askedById: session.user.id, question: parsed.data.question },
  });
  const recipient = otherParticipant(rel, session.user.id);
  if (recipient && recipient !== session.user.id) {
    await notify(recipient, 'question', `${session.user.name ?? 'Your mentee'} asked a question.`, `/mentor/mentees/${rel.id}`);
  }
  return NextResponse.json({ question: q }, { status: 201 });
}
