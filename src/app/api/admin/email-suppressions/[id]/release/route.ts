import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveQueueScope } from '@/lib/mailQueueAdmin';
import { releaseSuppression } from '@/lib/emailSuppression';
import { cleanReleaseReason } from '@/lib/emailSuppressionRule';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// POST — delist one suppressed address (#1692): `{ reason, confirm? }`. The
// reason is required (3–500 characters) and recorded with the actor on the row
// and on the ActivityLog. A complaint needs `confirm: true` (409
// `complaint_confirm_required` otherwise). Same scope as the list; a row
// outside it is 404, never a 403 that confirms the id.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const scope = await resolveQueueScope(session);
    if (!scope) return NextResponse.json({ error: 'Forbidden', code: 'mail_queue_operator_only' }, { status: 403 });
    const body = (await request.json().catch(() => null)) as { reason?: unknown; confirm?: unknown } | null;
    const reason = cleanReleaseReason(body?.reason);
    if (!reason) return NextResponse.json({ error: 'A reason is required', code: 'reason_required' }, { status: 400 });
    const { id } = await params;
    const out = await releaseSuppression(scope, id, { actorId: session.user.id, reason, confirm: body?.confirm === true, request });
    if (!out.ok) return NextResponse.json({ error: out.code, code: out.code }, { status: out.status });
    return NextResponse.json({ ok: true, row: out.row });
  });
}
