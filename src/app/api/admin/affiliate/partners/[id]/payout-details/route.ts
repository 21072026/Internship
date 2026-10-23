import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { revealPayoutDetails } from '@/lib/affiliatePayoutDetails';

// GET — a partner's FULL payout details, for the admin who makes the transfer
// (docs/affiliate-module.md). `affiliate.write` — the people who pay, not every
// reader of the programme — and every reveal is audited.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const { id } = await params;
  const partner = await prisma.affiliatePartner.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!partner) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ details: await revealPayoutDetails(orgId, partner.id, auth.session.user.id) });
}
