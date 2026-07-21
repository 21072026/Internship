import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed } from '@/lib/messaging';

// Fixed reaction set — keeps input bounded (no arbitrary strings stored).
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🎉'] as const;

const schema = z.object({ emoji: z.enum(REACTION_EMOJIS) });

// POST — toggle the current user's reaction with the given emoji on a message.
// Thread participants (and admins) only. Adding the same emoji again removes it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const message = await prisma.message.findUnique({ where: { id }, select: { relationId: true, deletedForEveryoneAt: true } });
  if (!message) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const rel = await getThreadIfAllowed({ id: session.user.id, role: session.user.role }, message.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (message.deletedForEveryoneAt) return NextResponse.json({ error: 'Message deleted' }, { status: 409 });

  const key = { messageId_userId_emoji: { messageId: id, userId: session.user.id, emoji: parsed.data.emoji } };
  const existing = await prisma.messageReaction.findUnique({ where: key });
  if (existing) {
    await prisma.messageReaction.delete({ where: key });
    return NextResponse.json({ ok: true, active: false });
  }
  await prisma.messageReaction.create({ data: { messageId: id, userId: session.user.id, emoji: parsed.data.emoji } });
  return NextResponse.json({ ok: true, active: true });
}
