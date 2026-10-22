import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { canInviteExternal, nextStep } from '@/lib/documentReview';
import { actorFacts, loadReviewDocument, newReviewToken } from '@/lib/documentReviewStore';
import { requirementLabel } from '@/lib/documentRequirements';
import { sendDocumentReviewInviteEmail } from '@/services/emailService';
import { isLocale } from '@/i18n/config';

const bodySchema = z.object({ email: z.string().trim().toLowerCase().email().max(191) }).strict();

// POST — send the current EXTERNAL step's link to the person who must decide it
// (#1859): an employer supervisor, say, who has no account. The programme (an
// ADMIN) or the owner's ACTIVE mentor names the address — never the owner, who
// could otherwise approve their own document. Sending again rotates the token,
// so only the newest link works; deciding the step clears it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { id } = await params;
    const orgId = resolveOrgId(session);

    return withTenantScope(session, async () => {
      const doc = await loadReviewDocument(id);
      if (!doc || !doc.requirement || doc.reviews.length === 0 || (orgId && doc.requirement.orgId !== orgId)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      const current = doc.reviewStatus === 'PENDING' ? nextStep(doc.reviews) : null;
      if (!current || current.reviewerRole !== 'EXTERNAL') {
        return NextResponse.json({ error: 'The current step is not an external one', code: 'not_external_step' }, { status: 409 });
      }
      const facts = await actorFacts({ id: session.user.id, role: session.user.role }, doc.ownerId);
      if (!canInviteExternal({ actorRole: session.user.role, ...facts })) {
        return NextResponse.json({ error: 'Forbidden', code: 'not_allowed' }, { status: 403 });
      }
      // The reviewer most likely reads the owner's language; the org's brand comes from orgId.
      const pref = doc.owner?.preferredLanguage;
      const locale = isLocale(pref) ? pref : 'en';
      const token = newReviewToken();
      const set = await prisma.documentReview.updateMany({
        where: { id: current.id, decision: null },
        data: { reviewerEmail: parsed.data.email, reviewToken: token },
      });
      if (set.count !== 1) return NextResponse.json({ error: 'already_decided', code: 'already_decided' }, { status: 409 });
      await sendDocumentReviewInviteEmail({
        to: parsed.data.email,
        token,
        documentTitle: doc.title,
        requirement: requirementLabel(doc.requirement.labels, locale, doc.requirement.key),
        ownerName: doc.owner?.fullName ?? '',
        locale,
        orgId: doc.requirement.orgId,
      });
      await logActivity({
        action: 'document.review.invite',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'document',
        targetId: doc.id,
        detail: `step ${current.step}`,
        request,
        orgId: doc.requirement.orgId,
      });
      return NextResponse.json({ ok: true, step: current.step });
    });
  });
}
