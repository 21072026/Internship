import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { findOrCreateDirectConversation } from '@/lib/conversations';
import { outreachActorWhere } from '@/lib/outreach';
import { actorFromSession, can } from '@/lib/authz';
import { canRevoke, decisionTarget } from '@/lib/outreachRule';

// PATCH /api/company/outreach/[id] (#1840) — the gate and the candidate's control.
//
//   approve | decline — the candidate's ACTIVE mentor or an ADMIN of the org.
//     A guarded updateMany on PENDING (the interview-request idiom), so two
//     deciders cannot both win. Approve: create or reuse the DIRECT
//     conversation between the requesting company user and the candidate, post
//     the stored first message, tell the candidate WITH the company's name.
//     Decline: nothing is delivered; the company hears "not approved" — never
//     who decided or why (no reason is even accepted here).
//   revoke — the candidate, on an APPROVED channel. Sets REVOKED (+ revokedAt,
//     which blocks a new request for 90 days) and removes the company user from
//     the conversation; canMessage() re-reads the status on every post, so the
//     company cannot write into the thread afterwards. Free core: never gated.
//
// A row outside the caller's scope (outreachActorWhere) answers 404.

const bodySchema = z.object({ action: z.enum(['approve', 'decline', 'revoke']) }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { action } = parsed.data;
  const role = session.user.role;
  const actor = await actorFromSession(session);
  const isAdmin = !!actor && (await can(actor, 'company.write', undefined, session));
  const allowed = action === 'revoke' ? role === 'MENTEE' : role === 'MENTOR' || isAdmin;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const scope = outreachActorWhere({ role, userId: session.user.id, orgId, companyId: session.user.companyId });
  if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { id } = await params;

  return withTenantScope(session, async () => {
    const row = await prisma.candidateOutreach.findFirst({
      where: { id, ...scope },
      select: {
        id: true,
        status: true,
        menteeId: true,
        requestedById: true,
        firstMessage: true,
        conversationId: true,
        company: { select: { name: true } },
        mentee: { select: { fullName: true } },
      },
    });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const now = new Date();

    if (action === 'revoke') {
      if (!canRevoke(row.status)) return NextResponse.json({ error: 'Nothing to close', code: 'not_open' }, { status: 409 });
      const changed = await prisma.candidateOutreach.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'REVOKED', revokedAt: now } });
      if (changed.count === 0) return NextResponse.json({ error: 'Nothing to close', code: 'not_open' }, { status: 409 });
      if (row.conversationId) {
        await prisma.conversationParticipant.deleteMany({ where: { conversationId: row.conversationId, userId: row.requestedById } });
      }
      await notify(row.requestedById, 'outreach.revokedCompany', { name: row.mentee.fullName }, '/company');
      await logActivity({ action: 'outreach.revoked', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'candidate_outreach', targetId: row.id, orgId });
      return NextResponse.json({ request: { id: row.id, status: 'REVOKED' } });
    }

    const target = decisionTarget(row.status, action === 'approve' ? 'APPROVE' : 'DECLINE');
    if (!target) return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });
    const changed = await prisma.candidateOutreach.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: target, decidedById: session.user.id, decidedAt: now },
    });
    if (changed.count === 0) return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });

    if (target === 'DECLINED') {
      await notify(row.requestedById, 'outreach.declinedCompany', { name: row.mentee.fullName }, '/company');
      await logActivity({ action: 'outreach.declined', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'candidate_outreach', targetId: row.id, orgId });
      return NextResponse.json({ request: { id: row.id, status: target } });
    }

    // APPROVED is committed, so canMessage() now lets the pair talk.
    const conversation = await findOrCreateDirectConversation(row.requestedById, row.menteeId);
    if (!conversation) {
      // The company user or the candidate is gone: undo, deliver nothing.
      await prisma.candidateOutreach.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'PENDING', decidedById: null, decidedAt: null } });
      return NextResponse.json({ error: 'The conversation could not be opened', code: 'unreachable' }, { status: 409 });
    }
    // A thread closed by an earlier revoke gets the company user back.
    await prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId: row.requestedById } },
      create: { conversationId: conversation.id, userId: row.requestedById },
      update: {},
    });
    if (row.firstMessage) {
      await prisma.message.create({ data: { conversationId: conversation.id, senderId: row.requestedById, body: row.firstMessage } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: now } });
    }
    await prisma.candidateOutreach.update({ where: { id: row.id }, data: { conversationId: conversation.id } });
    await notify(row.menteeId, 'outreach.approvedCandidate', { company: row.company.name }, `/messages/c/${conversation.id}`);
    await notify(row.requestedById, 'outreach.approvedCompany', { name: row.mentee.fullName }, `/messages/c/${conversation.id}`);
    await logActivity({ action: 'outreach.approved', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'candidate_outreach', targetId: row.id, orgId });
    return NextResponse.json({ request: { id: row.id, status: target, conversationId: conversation.id } });
  });
}
