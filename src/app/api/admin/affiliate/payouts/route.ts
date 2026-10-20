import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// Records a manual bank transfer to one partner: the admin pays by hand, then
// marks the commissions it covers as PAID in one payout (docs/affiliate-module.md,
// decision 10).
//
// Every commission must belong to this partner and this organisation and still
// be unpaid. If any of them does not, nothing is written: the caller gets 409
// and can reload the list. The partner row is locked so two payouts cannot pay
// the same commission.

const payoutSchema = z.object({
  partnerId: z.string().min(1).max(64),
  commissionIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  paidAt: z.string().datetime(),
  reference: z.string().trim().max(120).optional(),
});

const OPEN_STATUSES = ['PENDING', 'APPROVED'] as const;

// Thrown inside the transaction so that a refusal rolls back everything written
// before it. Returning a value instead would COMMIT a payout with no commissions.
class PayoutRefused extends Error {
  constructor(readonly code: 'commission_conflict' | 'UNSUPPORTED_CURRENCY') {
    super(code);
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN' || !session.user.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.user.orgId;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = payoutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const ids = [...new Set(body.commissionIds)];

  return withTenantScope(session, async () => {
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM \`AffiliatePartner\` WHERE id = ${body.partnerId} FOR UPDATE`;

        const commissions = await tx.affiliateCommission.findMany({
          where: { id: { in: ids }, orgId, partnerId: body.partnerId, status: { in: [...OPEN_STATUSES] } },
          select: { id: true, amountMinor: true, currency: true },
        });
        if (commissions.length !== ids.length) throw new PayoutRefused('commission_conflict');
        if (commissions.some((c) => c.currency !== 'EUR')) throw new PayoutRefused('UNSUPPORTED_CURRENCY');

        const amountMinor = commissions.reduce((sum, c) => sum + c.amountMinor, 0);
        const payout = await tx.affiliatePayout.create({
          data: {
            orgId,
            partnerId: body.partnerId,
            amountMinor,
            currency: 'EUR',
            reference: body.reference ?? null,
            paidAt: new Date(body.paidAt),
            paidById: session.user.id,
          },
          select: { id: true },
        });

        // Guarded by the status in the WHERE: a commission paid in the meantime
        // is not counted, and the whole payout is rolled back.
        const marked = await tx.affiliateCommission.updateMany({
          where: { id: { in: ids }, orgId, partnerId: body.partnerId, status: { in: [...OPEN_STATUSES] } },
          data: { status: 'PAID', payoutId: payout.id, paidAt: new Date(body.paidAt) },
        });
        if (marked.count !== ids.length) throw new PayoutRefused('commission_conflict');

        return { payoutId: payout.id, amountMinor, count: ids.length };
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof PayoutRefused) {
        const status = err.code === 'UNSUPPORTED_CURRENCY' ? 422 : 409;
        return NextResponse.json({ error: err.code }, { status });
      }
      throw err;
    }
  });
}
