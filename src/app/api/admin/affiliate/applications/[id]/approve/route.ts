import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { ApplicationReviewError, approveApplication } from '@/lib/affiliateApplicationReview';

// POST { code } — approves a partner application (#3362): creates the partner
// with that referral code and sends the ordinary partner invitation.
// `affiliate.write`. Another org's id is 404; a decided one 409.
const STATUS: Record<ApplicationReviewError['code'], number> = { not_found: 404, already_decided: 409, invalid_code: 400, code_taken: 409 };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== 'string') return NextResponse.json({ code: 'invalid_code' }, { status: 400 });
  try {
    const result = await approveApplication({
      orgId,
      applicationId: id,
      code: body.code,
      actor: { id: auth.session.user.id, email: auth.session.user.email },
      request,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ApplicationReviewError) {
      if (e.code === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ code: e.code }, { status: STATUS[e.code] });
    }
    throw e;
  }
}
