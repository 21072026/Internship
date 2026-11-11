import { withRequestScope } from '@/lib/requestContext';
import { draftActionRoute } from '@/lib/outboxRoute';
import { requireRoleOrPermission } from '@/lib/authz';

export const dynamic = 'force-dynamic';

// POST — Discard a held mail: the draft becomes DISCARDED and its sealed copy is deleted; nothing is sent (#2960).
// One guarded updateMany from DRAFT plus its AuditLog row
// (src/lib/outboundDrafts.ts § applyDraftAction).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requireRoleOrPermission(['MENTOR'], 'mail.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const { id } = await params;
    return draftActionRoute(session, id, 'discard', request);
  });
}
