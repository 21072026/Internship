import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import { notify } from '@/lib/notify';

// GET ?relationId= — messages in a thread (participants/admin only).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const relationId = new URL(request.url).searchParams.get('relationId') || '';
  const rel = await getThreadIfAllowed(session.user, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const messages = await prisma.message.findMany({
    where: { relationId },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    relationId,
    mentor: rel.mentor,
    mentee: rel.mentee,
    messages,
  });
}

const schema = z.object({ relationId: z.string().min(1), body: z.string().min(1).max(5000) });

// POST — post a message to a thread (participants/admin). Notifies the other party.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const message = await prisma.message.create({
    data: { relationId: rel.id, senderId: session.user.id, body: parsed.data.body, channel: 'IN_APP' },
  });

  // Notify the other participant (unless an admin is posting to someone else's thread).
  const recipient = otherParticipant(rel, session.user.id);
  if (recipient && recipient !== session.user.id) {
    await notify(recipient, 'message', `New message from ${session.user.name ?? 'your mentor'}.`, `/messages/${rel.id}`);
  }

  return NextResponse.json({ message }, { status: 201 });
}
