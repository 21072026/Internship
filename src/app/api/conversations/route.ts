import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { findOrCreateDirectConversation } from '@/lib/conversations';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({ userId: z.string().min(1) });

// POST — create-or-get the 1:1 (DIRECT) conversation with another user (#769).
// Idempotent: calling it repeatedly for the same pair returns the same
// conversation. 403 when the two aren't allowed to message each other, which
// today means they share no project and have no mentorship (see canMessage).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const targetId = parsed.data.userId;
    if (targetId === session.user.id) {
      return NextResponse.json({ error: 'Cannot message yourself' }, { status: 400 });
    }

    // Authorization lives inside findOrCreateDirectConversation, so it can never
    // be bypassed by a caller that forgets to check first.
    const conversation = await findOrCreateDirectConversation(session.user.id, targetId);
    if (!conversation) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        type: conversation.type,
        participants: conversation.participants.map((p) => ({ id: p.user.id, fullName: p.user.fullName })),
      },
    });
  });
}
