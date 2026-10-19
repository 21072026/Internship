import { NextResponse } from 'next/server';
import { notFound } from 'next/navigation';
import { getServerSession, type Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { outboundApprovalApplies, type OutboundAction } from '@/lib/outboundApprovalRule';
import { applyDraftAction, type DraftActionResult, type OutboxActor } from '@/lib/outboundDrafts';

// The shared half of the outbox routes (#2960, /api/admin/outbox/**). Each
// route reads the session itself and refuses anybody but an ADMIN or a MENTOR
// (scripts/check-route-auth.mjs wants that line in the route file); this file
// adds the vertical gate and the response shapes, so the routes cannot answer
// differently for the same refusal.

/**
 * The outbox exists only in a vertical that can hold mail (the sales vertical,
 * `outboundApprovalApplies`). Anywhere else: 403 `capability_unavailable`, the
 * shape `requireCapability()` answers with. A MENTOR of that vertical is a sales
 * rep; what they may see is narrowed further by `visibleDraftsWhere()`.
 */
export async function outboxActorFor(session: Session): Promise<OutboxActor | NextResponse> {
  const caps = await shellCapabilities(session.user.orgId);
  if (!outboundApprovalApplies(caps)) {
    return NextResponse.json(
      { code: 'capability_unavailable', capability: 'outbox', error: 'The outbox is not part of your organization\'s product.' },
      { status: 403 },
    );
  }
  return { id: session.user.id, role: session.user.role, orgId: session.user.orgId ?? null, email: session.user.email ?? null };
}

export function draftActionResponse(result: DraftActionResult): NextResponse {
  if (result.ok) return NextResponse.json({ ok: true, status: result.status, jobId: result.jobId });
  return NextResponse.json({ error: result.code, code: result.code }, { status: result.httpStatus });
}

/**
 * The PAGE half of the same gate, for /admin/outbox and /sales/outbox:
 * notFound() for a vertical that cannot hold mail and for a role the outbox
 * has no view for. No session: returns (the shell redirects to sign-in).
 */
export async function gateOutboxPage(): Promise<void> {
  const session = await getServerSession(authOptions);
  if (!session) return;
  if (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR') notFound();
  if (!outboundApprovalApplies(await shellCapabilities(session.user.orgId))) notFound();
}

/** One action on one draft, for the three per-draft routes. */
export async function draftActionRoute(
  session: Session,
  id: string,
  action: OutboundAction,
  request: Request,
  scheduledFor?: Date | null,
): Promise<NextResponse> {
  const actor = await outboxActorFor(session);
  if (actor instanceof NextResponse) return actor;
  return draftActionResponse(await applyDraftAction(actor, id, action, { scheduledFor, request }));
}
