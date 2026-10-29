import { NextResponse } from 'next/server';
import { withRequestScope } from '@/lib/requestContext';
import { outboxActorFor } from '@/lib/outboxRoute';
import { draftDetail } from '@/lib/outboundDrafts';
import { requireRoleOrPermission } from '@/lib/authz';

export const dynamic = 'force-dynamic';

// GET — One held mail with its full content, for the outbox preview (#2960).
// 404 for a draft this caller may not see — another org's, or (for a sales rep)
// one addressed to somebody else's lead — exactly like a missing id, so the
// answer never confirms that the id exists. The HTML is rendered by the page in
// a sandboxed iframe without scripts.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requireRoleOrPermission(['MENTOR'], 'mail.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const actor = await outboxActorFor(session);
    if (actor instanceof NextResponse) return actor;
    const { id } = await params;
    const draft = await draftDetail(actor, id);
    if (!draft) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ draft }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
