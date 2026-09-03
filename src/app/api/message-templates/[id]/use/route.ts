import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';

// POST — record that a canned response was inserted into a composer (#1871).
//
// Its own endpoint rather than a field on POST /api/messages, because the two
// are not the same event: a template is "used" the moment it lands in the box,
// whether or not the writer then edits it beyond recognition or abandons the
// reply. `useCount` exists to rank the picker — "which wording do people
// actually reach for" — and the reach is the interesting part.
//
// Nothing here reads back to the client, and a failure is swallowed by the
// caller: a counter that missed a tick must never cost someone their reply.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // A counter increment is the cheapest possible write, but it is still a write
  // on a per-click endpoint, so it gets the same guard as every other one here.
  const limited = enforceRateLimit(request, 'message-template-use', { limit: 120, windowMs: 60 * 1000 });
  if (limited) return limited;

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return await withTenantScope(session, async () => {
    // Same visibility rule as the list: org-wide, or my own. updateMany (not
    // update) so "not mine" is a 404 rather than a thrown P2025, and so the
    // ownership filter and the increment are one statement.
    const bumped = await prisma.messageTemplate.updateMany({
      where: {
        id,
        archivedAt: null,
        OR: [{ ownerId: null }, { ownerId: session.user.id }],
      },
      data: { useCount: { increment: 1 } },
    });
    if (bumped.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
