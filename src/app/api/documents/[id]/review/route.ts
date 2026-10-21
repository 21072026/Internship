import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { REVIEW_DECISIONS } from '@/lib/documentReview';
import { decideStep, loadReviewDocument } from '@/lib/documentReviewStore';

const bodySchema = z.object({
  step: z.number().int().min(1).max(10),
  decision: z.enum(REVIEW_DECISIONS),
  note: z.string().trim().max(2000).optional(),
}).strict();

// POST — decide the current step of a document's review chain (#1859), as a
// signed-in reviewer whose role matches that step (src/lib/documentReview.ts
// canDecideStep: an ADMIN of the org, the owner's ACTIVE mentor, a user of the
// company the owner is actively placed with — never the owner). `step` is the
// step the reviewer saw; any other answers 409 `out_of_order`, so steps go in
// order. A rejection needs a note — it is the reason the owner is told.
// Another org's document is a 404, never a 403 that confirms the id.
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
      const result = await decideStep({
        doc,
        step: parsed.data.step,
        decision: parsed.data.decision,
        note: parsed.data.note,
        by: { kind: 'user', id: session.user.id, role: session.user.role, companyId: session.user.companyId ?? null },
      });
      if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
      await logActivity({
        action: 'document.review',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'document',
        targetId: doc.id,
        detail: `step ${result.step}: ${parsed.data.decision} -> ${result.documentStatus}`,
        request,
        orgId: doc.requirement.orgId,
      });
      return NextResponse.json({ reviewStatus: result.documentStatus, step: result.step });
    });
  });
}
