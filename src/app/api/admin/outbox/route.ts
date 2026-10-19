import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { outboxActorFor } from '@/lib/outboxRoute';
import { listDrafts, outboundApprovalOn, pendingDraftCount } from '@/lib/outboundDrafts';
import { OUTBOUND_DRAFT_STATUSES, OUTBOUND_TRIGGERS, type OutboundDraftStatus } from '@/lib/outboundApprovalRule';

export const dynamic = 'force-dynamic';

// GET — The outbox (#2960): automated mail to leads and customers that the organization holds for approval.
// An ADMIN sees every draft of their org; a MENTOR (a sales rep) only the
// drafts addressed to a lead or an account they own (visibleDraftsWhere in
// src/lib/outboundDrafts.ts). `?count=1` answers the nav badge's pending count
// only. Rows carry the subject, the recipient's display name and a masked
// address — never the full address; the preview route has that.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await outboxActorFor(session);
    if (actor instanceof NextResponse) return actor;
    const url = new URL(request.url);
    if (url.searchParams.get('count') === '1') return NextResponse.json({ pending: await pendingDraftCount(actor) });
    const rawStatus = url.searchParams.get('status') ?? 'DRAFT';
    const status: OutboundDraftStatus | 'ALL' =
      rawStatus === 'ALL' || (OUTBOUND_DRAFT_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as OutboundDraftStatus | 'ALL') : 'DRAFT';
    const rawTrigger = url.searchParams.get('trigger');
    const trigger = rawTrigger && (OUTBOUND_TRIGGERS as readonly string[]).includes(rawTrigger) ? rawTrigger : null;
    const [list, approvalOn] = await Promise.all([listDrafts(actor, { status, trigger }), outboundApprovalOn(actor.orgId)]);
    return NextResponse.json({ ...list, approvalOn, scope: actor.role === 'ADMIN' ? 'org' : 'own' });
  });
}
