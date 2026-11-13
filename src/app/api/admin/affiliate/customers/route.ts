import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { listAdminCustomers } from '@/lib/affiliateCustomerList';
import { AFFILIATE_CURRENCIES } from '@/lib/affiliateProgramSettings';

// GET — the programme's referred customers, one row each (docs/affiliate-module.md
// § Customers, #3538). `affiliate.read`, read-only, newest first, paged.
// `?partnerId=` narrows to one partner; a partner of another organisation (or one
// that does not exist) answers 404, never another tenant's rows.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const url = new URL(request.url);
  const partnerId = url.searchParams.get('partnerId') || null;
  if (partnerId && !(await prisma.affiliatePartner.findFirst({ where: { id: partnerId, orgId }, select: { id: true } }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const [list, settings] = await Promise.all([
    listAdminCustomers(orgId, { partnerId, page: Number(url.searchParams.get('page') ?? 1) || 1 }),
    prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true } }),
  ]);
  // Commissions are in the plan's one currency (the payments route reads it the same way).
  const currency = (settings?.plan as { currency?: string } | null)?.currency ?? AFFILIATE_CURRENCIES[0];
  return NextResponse.json({ ...list, currency });
}
