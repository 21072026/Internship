import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { queueActionResponse } from '@/lib/mailQueueRoute';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// POST — Put a FAILED or DEAD_LETTER mail back on the queue (attempts reset), while its deadline has not passed and its envelope is still on the row.
// The admin Queue tab's action (#2953). Who may, and on which rows, is the
// queue's scope rule (src/lib/mailOpsRule.ts § queueScopeFor); the write is one
// guarded updateMany plus an AuditLog row in the same transaction
// (src/lib/mailQueueAdmin.ts § applyQueueAction).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    return queueActionResponse('retry', session, id, request);
  });
}
