import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { draftActionRoute } from '@/lib/outboxRoute';

export const dynamic = 'force-dynamic';

// POST — Discard a held mail: the draft becomes DISCARDED and its sealed copy is deleted; nothing is sent (#2960).
// One guarded updateMany from DRAFT plus its AuditLog row
// (src/lib/outboundDrafts.ts § applyDraftAction).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    return draftActionRoute(session, id, 'discard', request);
  });
}
