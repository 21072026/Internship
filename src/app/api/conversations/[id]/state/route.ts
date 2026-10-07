import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getConversationIfAllowed } from '@/lib/conversations';
import { MUTE_CHOICES, muteUntil } from '@/lib/conversationState';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';

// PATCH — the caller's own inbox state for one conversation (#1609): archive,
// pin, mute. Body: any of `archived: boolean`, `pinned: boolean`,
// `mute: '8h' | '1w' | 'forever' | null` (null unmutes).
//
// It writes the caller's OWN ConversationParticipant row and nothing else, so
// the gate is two-fold: the conversation must open for them (the same gate as
// reading it), and they must have a row in it — an admin who may read a 1:1
// thread they are not part of has no inbox state there to set.
//
// Messaging is free for mentors and mentees — nothing here is plan-gated.

const schema = z
  .object({
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    mute: z.enum(MUTE_CHOICES).nullable().optional(),
  })
  .strict()
  .refine((d) => d.archived !== undefined || d.pinned !== undefined || d.mute !== undefined, { message: 'nothing to change' });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePatch(request, params));
}

async function handlePatch(request: Request, params: Promise<{ id: string }>) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'conversation-state', { limit: 60, windowMs: 60 * 1000, subject: session.user.id });
  if (limited) return limited;
  const { id } = await params;

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const conversation = await getConversationIfAllowed(session.user, id);
    if (!conversation || !conversation.participants.some((p) => p.userId === session.user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const now = new Date();
    const { archived, pinned, mute } = parsed.data;
    const state = await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: conversation.id, userId: session.user.id } },
      data: {
        ...(archived !== undefined ? { archivedAt: archived ? now : null } : {}),
        ...(pinned !== undefined ? { pinnedAt: pinned ? now : null } : {}),
        ...(mute !== undefined ? { mutedUntil: mute ? muteUntil(mute, now) : null } : {}),
      },
      select: { archivedAt: true, mutedUntil: true, pinnedAt: true },
    });
    return NextResponse.json({ state });
  });
}
