import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { ApplicationReviewError, rejectApplication } from '@/lib/affiliateApplicationReview';
import { isRejectionCode } from '@/lib/affiliateApplicationRule';

// POST { reason, note? } — declines a partner application (#3362). `reason` is a
// code from APPLICATION_REJECTION_CODES (its sentence is what the applicant
// reads); `note` is the admin's own words and goes to the audit row only.
// `affiliate.write`. Another org's id is 404; a decided one 409.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null;
  if (!isRejectionCode(body?.reason)) return NextResponse.json({ code: 'invalid_reason' }, { status: 400 });
  const note = typeof body?.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
  try {
    await rejectApplication({ orgId, applicationId: id, reason: body.reason, note, actor: { id: auth.session.user.id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ApplicationReviewError) {
      if (e.code === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ code: e.code }, { status: 409 });
    }
    throw e;
  }
}
