import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { applyQueueAction, resolveQueueScope } from '@/lib/mailQueueAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import type { QueueAction } from '@/lib/mailOpsRule';

// The shared body of POST /api/admin/mail-queue/[id]/retry and …/cancel
// (#2953). Each route asks who is calling itself (getServerSession — the
// route-auth guard reads the route file); this decides what that caller may do
// to which row.
//
// Answers: 200 { ok, status } · 401 no session or not an ADMIN (checked in the
// route file itself) · 403 an ADMIN who is not an operator of the queue · 404 no such mail IN THE CALLER'S SCOPE (another tenant's id reads
// exactly like a missing one) · 409 { code } the row is not in a state the
// action applies to (`wrong_state`, `expired`, `no_envelope`), or another
// operator changed it first (`conflict`).
export async function queueActionResponse(
  action: QueueAction,
  session: Session,
  jobId: string,
  request: Request,
): Promise<NextResponse> {
  const scope = await resolveQueueScope(session);
  if (!scope) return NextResponse.json({ error: 'Forbidden', code: 'mail_queue_operator_only' }, { status: 403 });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
  const result = await applyQueueAction(
    action,
    jobId,
    scope,
    { id: session.user.id, email: session.user.email ?? null, orgId: resolveOrgId(session) },
    request,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.code === 'not_found' ? 'Not found' : 'Conflict', code: result.code }, { status: result.httpStatus });
  }
  return NextResponse.json({ ok: true, status: result.status });
}
