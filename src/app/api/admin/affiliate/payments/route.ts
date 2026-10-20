import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { AffiliatePaymentError } from '@/lib/affiliatePaymentPlan';
import { recordAffiliatePayment } from '@/lib/affiliatePaymentWriter';

// Admin side of the affiliate programme (docs/affiliate-module.md).
//
// GET  — the partners to pick from, and the most recent payments with their
//        commission. Scoped to the admin's own organisation.
// POST — record one payment a referred customer made. It goes through the single
//        writer, so the same rules apply as for any future API import.

const recordSchema = z.object({
  partnerId: z.string().min(1).max(64),
  externalCustomerRef: z.string().trim().min(1).max(120),
  amountMinor: z.number().int().positive().max(100_000_000),
  currency: z.string().length(3),
  receivedAt: z.string().datetime(),
  externalPaymentRef: z.string().trim().min(1).max(120),
});

const ERROR_STATUS: Record<AffiliatePaymentError['code'], number> = {
  INVALID_AMOUNT: 422,
  UNSUPPORTED_CURRENCY: 422,
  MISSING_REFERENCE: 422,
  PAYMENT_BEFORE_FIRST_PAYMENT: 422,
  PARTNER_NOT_FOUND: 404,
  CUSTOMER_OF_ANOTHER_PARTNER: 409,
};

async function requireAdminOrg() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  if (!session.user.orgId) return null;
  return session;
}

export async function GET() {
  const session = await requireAdminOrg();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = session.user.orgId as string;

  return withTenantScope(session, async () => {
    const [partners, payments] = await Promise.all([
      prisma.affiliatePartner.findMany({
        where: { orgId },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, user: { select: { fullName: true } } },
      }),
      prisma.affiliatePayment.findMany({
        where: { orgId },
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          amountMinor: true,
          currency: true,
          receivedAt: true,
          externalPaymentRef: true,
          source: true,
          customer: { select: { externalRef: true, partner: { select: { id: true, code: true } } } },
          commission: { select: { id: true, kind: true, amountMinor: true, status: true } },
        },
      }),
    ]);
    return NextResponse.json({ partners, payments });
  });
}

export async function POST(request: Request) {
  const session = await requireAdminOrg();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = session.user.orgId as string;

  const parsed = recordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  return withTenantScope(session, async () => {
    try {
      const result = await prisma.$transaction((tx) =>
        recordAffiliatePayment(tx, {
          orgId,
          partnerId: body.partnerId,
          externalCustomerRef: body.externalCustomerRef,
          amountMinor: body.amountMinor,
          currency: body.currency.toUpperCase(),
          receivedAt: new Date(body.receivedAt),
          externalPaymentRef: body.externalPaymentRef,
          source: 'MANUAL',
          enteredById: session.user.id,
        }),
      );
      if (result.status === 'DUPLICATE') {
        return NextResponse.json({ error: 'duplicate_payment' }, { status: 409 });
      }
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof AffiliatePaymentError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: ERROR_STATUS[err.code] });
      }
      throw err;
    }
  });
}
