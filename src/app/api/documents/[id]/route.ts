import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { canAccessUserDocs } from '@/lib/documentAccess';
import { logActivity } from '@/lib/activity';
import { downloadHeaders } from '@/lib/download';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { userInCallerOrg } from '@/lib/ownerOrg';
import { canDecideStep, nextStep } from '@/lib/documentReview';
import { actorFacts } from '@/lib/documentReviewStore';

// A reviewer must be able to read what they are asked to decide (#1859): the
// one extra reader is whoever may decide the document's CURRENT review step —
// in practice a company user on a COMPANY step, who has no other way in. It
// lapses the moment the step is decided.
async function isCurrentReviewer(user: { id: string; role: string; companyId?: string | null }, documentId: string, ownerId: string) {
  const reviews = await prisma.documentReview.findMany({ where: { documentId }, select: { step: true, decision: true, reviewerRole: true } });
  const current = nextStep(reviews);
  if (!current) return false;
  const status = await prisma.document.findUnique({ where: { id: documentId }, select: { reviewStatus: true } });
  if (status?.reviewStatus !== 'PENDING') return false;
  return canDecideStep({ stepRole: current.reviewerRole, actorRole: user.role, ...(await actorFacts(user, ownerId)) });
}

// Document carries no orgId (#2542). An owned document is its owner's org's; a
// template (no owner) is its uploader's. A document of another org answers 404
// — before any role check, so a 403 cannot confirm the id exists — for reads
// and deletes alike. Org-less on either side keeps today's behaviour.
async function loadInCallerOrg(id: string, callerOrgId: string | null) {
  const doc = await prisma.document.findUnique({ where: { id }, include: { owner: { select: { orgId: true } } } });
  if (!doc) return null;
  const inOrg = doc.isTemplate || !doc.ownerId
    ? await userInCallerOrg(doc.uploaderId, callerOrgId)
    : await inCallerTenant(doc.owner?.orgId, callerOrgId);
  return inOrg ? doc : null;
}

// GET — download a document (templates: any signed-in user; owned: access-controlled).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  return await withTenantScope(session, async () => {
  const doc = await loadInCallerOrg(id, resolveOrgId(session));
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!doc.isTemplate) {
    if (!doc.ownerId || !((await canAccessUserDocs(session.user, doc.ownerId)) || (await isCurrentReviewer(session.user, doc.id, doc.ownerId)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // Access log: who downloaded which document (visible in the admin activity log).
  await logActivity({
    action: 'document.download',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'document',
    targetId: doc.id,
    detail: doc.title,
  });

  return new NextResponse(Buffer.from(doc.data), {
    headers: downloadHeaders({ filename: doc.filename, contentType: doc.contentType, size: doc.size }),
  });
  });
}

// DELETE — remove a document. Templates: admin only. Owned: access-controlled.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  return await withTenantScope(session, async () => {
  const doc = await loadInCallerOrg(id, resolveOrgId(session));
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (doc.isTemplate) {
    // A template is the programme's content: an admin's write, by the permission layer (#1571).
    const actor = await actorFromSession(session);
    if (!actor || !(await can(actor, 'content.write', undefined, session))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (!doc.ownerId || !(await canAccessUserDocs(session.user, doc.ownerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.document.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
  });
}
