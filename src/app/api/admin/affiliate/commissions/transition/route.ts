import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateWriteError, MAX_COMMISSIONS_PER_ACTION, transitionCommissions } from '@/lib/affiliatePaymentWriter';

// POST — approve, reject or un-approve commissions (docs/affiliate-module.md).
// `affiliate.write`. Rows move under their partner's lock, only from the expected
// status; anything else (a PAID row, another org's id) comes back in `skipped`.
const schema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_COMMISSIONS_PER_ACTION),
  transition: z.enum(['APPROVE', 'REJECT', 'UNAPPROVE']),
});

export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  try {
    return NextResponse.json(await transitionCommissions(orgId, parsed.data.ids, parsed.data.transition, auth.session.user.id));
  } catch (e) {
    if (e instanceof AffiliateWriteError) return NextResponse.json({ code: e.code }, { status: e.code === 'busy' ? 503 : 409 });
    throw e;
  }
}
