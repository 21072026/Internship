import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { nextStep } from '@/lib/documentReview';
import { requirementLabel } from '@/lib/documentRequirements';
import { isLocale } from '@/i18n/config';

const TAKE = 100;

// GET — the review steps waiting on ME (#1859): an ADMIN sees the org's ADMIN
// steps and its EXTERNAL steps (whose link the programme sends); a MENTOR the
// MENTOR and EXTERNAL steps of mentees they actively mentor; a COMPANY user the
// COMPANY steps of people actively placed with their company. Only the CURRENT
// step of a PENDING document counts — a step behind an undecided one is not
// waiting on anybody yet. Bounded (`take`), oldest first.
export async function GET(request: Request) {
  // An admin is judged by the permission layer (#1571); MENTOR and COMPANY by role.
  const gate = await requireRoleOrPermission(['MENTOR', 'COMPANY'], 'content.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  const role = session.user.role;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  let scope: Prisma.DocumentReviewWhereInput;
  if (admin) scope = { reviewerRole: { in: ['ADMIN', 'EXTERNAL'] } };
  else if (role === 'MENTOR') scope = { reviewerRole: { in: ['MENTOR', 'EXTERNAL'] }, document: { owner: { menteeRelations: { some: { mentorId: session.user.id, status: 'ACTIVE' } } } } };
  else if (role === 'COMPANY' && session.user.companyId) scope = { reviewerRole: 'COMPANY', document: { owner: { menteeRelations: { some: { companyId: session.user.companyId, status: 'ACTIVE' } } } } };
  else return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const locale = new URL(request.url).searchParams.get('locale');

  return withTenantScope(session, async () => {
    const rows = await prisma.documentReview.findMany({
      where: { AND: [{ orgId, decision: null, document: { reviewStatus: 'PENDING' } }, scope] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TAKE,
      select: {
        id: true, step: true, reviewerRole: true, reviewerEmail: true, createdAt: true,
        document: {
          select: {
            id: true, title: true, filename: true, createdAt: true,
            owner: { select: { id: true, fullName: true } },
            requirement: { select: { key: true, labels: true } },
            reviews: { select: { id: true, step: true, decision: true } },
          },
        },
      },
    });
    const items = rows
      .filter((r) => nextStep(r.document.reviews)?.id === r.id)
      .map((r) => ({
        reviewId: r.id,
        documentId: r.document.id,
        title: r.document.title,
        filename: r.document.filename,
        owner: r.document.owner,
        requirement: r.document.requirement
          ? requirementLabel(r.document.requirement.labels, isLocale(locale) ? locale : 'en', r.document.requirement.key)
          : null,
        step: r.step,
        steps: r.document.reviews.length,
        reviewerRole: r.reviewerRole,
        // Only the address; the link itself is never read back.
        reviewerEmail: r.reviewerEmail,
        submittedAt: r.document.createdAt,
      }));
    return NextResponse.json({ items });
  });
}
