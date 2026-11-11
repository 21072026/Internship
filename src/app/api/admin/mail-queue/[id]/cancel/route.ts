import { requirePermission } from '@/lib/authz';
import { queueActionResponse } from '@/lib/mailQueueRoute';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// POST — Withdraw a mail that is still waiting (PENDING → CANCELLED, envelope cleared).
// The admin Queue tab's action (#2953). Who may, and on which rows, is the
// queue's scope rule (src/lib/mailOpsRule.ts § queueScopeFor); the write is one
// guarded updateMany plus an AuditLog row in the same transaction
// (src/lib/mailQueueAdmin.ts § applyQueueAction).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('mail.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const { id } = await params;
    return queueActionResponse('cancel', session, id, request);
  });
}
