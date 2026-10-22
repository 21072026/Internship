import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { listPayouts } from '@/lib/affiliatePayouts';
import { AffiliateWriteError, MAX_COMMISSIONS_PER_ACTION, createPayout } from '@/lib/affiliatePaymentWriter';

// Payouts (docs/affiliate-module.md, #3116). GET: `affiliate.read`, newest first.
// POST: `affiliate.write` — records a manual bank transfer: the selected APPROVED
// commissions of ONE partner become PAID together, or nothing does.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const url = new URL(request.url);
  const result = await listPayouts(orgId, { partnerId: url.searchParams.get('partnerId'), page: Number(url.searchParams.get('page') ?? 1) || 1 });
  return NextResponse.json({ ...result, canWrite: decide({ actor: auth.actor, permission: 'affiliate.write' }).allow });
}

const schema = z.object({
  partnerId: z.string().min(1),
  commissionIds: z.array(z.string().min(1)).min(1).max(MAX_COMMISSIONS_PER_ACTION),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().nullable().optional(),
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
    const result = await createPayout(
      orgId,
      {
        partnerId: parsed.data.partnerId,
        commissionIds: parsed.data.commissionIds,
        paidAt: new Date(`${parsed.data.paidOn}T00:00:00Z`),
        reference: parsed.data.reference ?? null,
      },
      auth.session.user.id,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AffiliateWriteError) {
      const status = e.code === 'partner_not_found' ? 404 : e.code === 'invalid_input' ? 400 : e.code === 'busy' ? 503 : 409;
      return NextResponse.json({ code: e.code }, { status });
    }
    throw e;
  }
}
