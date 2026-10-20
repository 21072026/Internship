import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { open } from '@/lib/secretBox';
import { decodePayoutDetails } from '@/lib/affiliatePayoutDetails';

// The partner's own summary. Everything is looked up by the signed-in user's id
// and organisation, so another partner's id cannot be reached from here.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'AFFILIATE' || !session.user.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.user.orgId;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  return withTenantScope(session, async () => {
    const partner = await prisma.affiliatePartner.findFirst({
      where: { userId: session.user.id, orgId },
      select: { id: true, code: true, status: true, payoutDetailsCipher: true },
    });
    if (!partner) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const commissions = await prisma.affiliateCommission.findMany({
      where: { partnerId: partner.id, orgId },
      orderBy: { accruedAt: 'desc' },
      take: 100,
      select: { id: true, kind: true, amountMinor: true, currency: true, status: true, accruedAt: true, paidAt: true },
    });

    let paidMinor = 0;
    let openMinor = 0;
    for (const c of commissions) {
      if (c.status === 'PAID') paidMinor += c.amountMinor;
      else if (c.status !== 'REJECTED') openMinor += c.amountMinor;
    }

    // Only the last four characters of the IBAN leave the server.
    const opened = partner.payoutDetailsCipher ? open(partner.payoutDetailsCipher, 'affiliate.payout') : null;
    const details = opened ? decodePayoutDetails(opened) : null;

    return NextResponse.json({
      code: partner.code,
      status: partner.status,
      totals: { paidMinor, openMinor, currency: 'EUR' },
      commissions,
      payout: details
        ? { accountHolder: details.accountHolder, ibanLast4: details.iban.slice(-4) }
        : null,
    });
  });
}
