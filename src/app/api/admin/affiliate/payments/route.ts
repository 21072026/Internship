import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { listPayments } from '@/lib/affiliatePayments';
import { parseCalendarDay } from '@/lib/calendarDay';
import { AffiliateWriteError, recordAffiliatePayment, type AffiliateWriteErrorCode } from '@/lib/affiliatePaymentWriter';

// The programme's customer payments (docs/affiliate-module.md, #3116).
// GET: `affiliate.read`, newest first, paged. POST: `affiliate.write` — a manual
// entry, recorded by the ONE writer (src/lib/affiliatePaymentWriter.ts), which
// also decides the commission. The currency is the plan's; the received date is
// a calendar day (UTC midnight) and never in the future.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const url = new URL(request.url);
  const result = await listPayments(orgId, { partnerId: url.searchParams.get('partnerId'), page: Number(url.searchParams.get('page') ?? 1) || 1 });
  return NextResponse.json({ ...result, canWrite: decide({ actor: auth.actor, permission: 'affiliate.write' }).allow });
}

const schema = z.object({
  partnerId: z.string().min(1).nullable().optional(),
  customerExternalRef: z.string(),
  amountMinor: z.number(),
  receivedOn: z.string(),
  externalPaymentRef: z.string(),
});

const STATUS: Record<AffiliateWriteErrorCode, number> = {
  invalid_input: 400,
  no_plan: 409,
  currency_mismatch: 400,
  partner_not_found: 404,
  partner_suspended: 409,
  unknown_customer: 400,
  customer_of_another_partner: 409,
  duplicate_payment: 409,
  payout_mismatch: 409,
  invalid_transition: 409,
  busy: 503,
  conflict: 409,
};

export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_input', issues: [] }, { status: 400 });
  const receivedAt = parseCalendarDay(parsed.data.receivedOn);
  if (!receivedAt) return NextResponse.json({ code: 'invalid_input', issues: ['received_at'] }, { status: 400 });
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true } });
  const currency = (settings?.plan as { currency?: string } | null)?.currency;
  if (!currency) return NextResponse.json({ code: 'no_plan' }, { status: 409 });

  try {
    const result = await recordAffiliatePayment({
      orgId,
      partnerId: parsed.data.partnerId ?? null,
      customerExternalRef: parsed.data.customerExternalRef,
      amountMinor: parsed.data.amountMinor,
      currency,
      receivedAt,
      externalPaymentRef: parsed.data.externalPaymentRef,
      source: 'MANUAL',
      enteredById: auth.session.user.id,
      // A calendar day typed in the admin's own zone: "today" east of UTC is
      // already tomorrow's UTC midnight. Up to +14 h is not "the future".
      now: new Date(Date.now() + 14 * 60 * 60 * 1000),
    });
    return NextResponse.json({ ...result, drift: result.drift.length }, { status: 201 });
  } catch (e) {
    if (e instanceof AffiliateWriteError) return NextResponse.json({ code: e.code, issues: e.issues }, { status: STATUS[e.code] });
    throw e;
  }
}
