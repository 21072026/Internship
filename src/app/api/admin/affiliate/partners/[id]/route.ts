import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateWriteError, changePartnerState } from '@/lib/affiliatePaymentWriter';

// PATCH — a partner's status and termination date (docs/affiliate-module.md).
// `affiliate.write`. Moves under the partner lock and re-evaluates the partner's
// commissions (src/lib/affiliatePaymentWriter.ts, changePartnerState). Another
// organisation's partner id answers 404, like an id that does not exist.
const schema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']),
  noticeEffectiveAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  const { id } = await params;
  try {
    const sync = await changePartnerState(
      orgId,
      id,
      { status: parsed.data.status, noticeEffectiveAt: parsed.data.noticeEffectiveAt ? new Date(parsed.data.noticeEffectiveAt) : null },
      auth.session.user.id,
    );
    return NextResponse.json({ ok: true, drift: sync?.drift.length ?? 0 });
  } catch (e) {
    if (e instanceof AffiliateWriteError) {
      if (e.code === 'partner_not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (e.code === 'invalid_input') return NextResponse.json({ code: 'notice_required' }, { status: 400 });
      return NextResponse.json({ code: e.code }, { status: 409 });
    }
    throw e;
  }
}
