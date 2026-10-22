import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { prisma as appPrisma } from '../src/lib/prisma';
import { recordAffiliatePayment, resyncPartnerCommissions, AffiliateWriteError } from '../src/lib/affiliatePaymentWriter';

/**
 * The affiliate payment writer against a real MySQL (docs/affiliate-module.md, #3114).
 *
 * Browserless. The pure engine and reconciliation are pinned by unit tests
 * (scripts/test/affiliate-commission-*.test.mjs); this spec pins what only the
 * database can show: the partner lock serializes concurrent payments, unique keys
 * map to the right codes, frozen rows survive a plan change, and a plan change
 * never pays retroactively. @smoke: it is a money boundary.
 *
 * SYNTHETIC ONLY: a throwaway org per run, currency XTS.
 */

const PLAN = {
  currency: 'XTS',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: 2,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};

let orgId = '';
let partnerId = '';
let otherId = '';

const base = () => ({ orgId, currency: 'XTS', source: 'MANUAL' as const });
const d = (iso: string) => new Date(iso);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ACCEPTED';
  } catch (e) {
    if (e instanceof AffiliateWriteError) return e.issues.length ? `${e.code}:${e.issues.join(',')}` : e.code;
    throw e;
  }
}

async function commissions() {
  const rows = await prisma.affiliateCommission.findMany({
    where: { orgId },
    include: { payment: { select: { externalPaymentRef: true } } },
    orderBy: { accruedAt: 'asc' },
  });
  return rows.map((c) => `${c.payment.externalPaymentRef}:${c.kind}:${c.amountMinor}:${c.status}:v${c.planVersion}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-${stamp}` } });
  orgId = org.id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'p-one', displayName: 'Partner One' } })).id;
  otherId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'p-two', displayName: 'Partner Two' } })).id;
});

test.afterAll(async () => {
  if (orgId) {
    const where = { orgId };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('concurrent payments of one partner are serialized by the lock', { tag: '@smoke' }, async () => {
  const [a, b, c] = await Promise.all([
    recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-a', amountMinor: 800, receivedAt: d('2026-03-01T10:00:00Z'), externalPaymentRef: 'inv-1' }),
    recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-b', amountMinor: 800, receivedAt: d('2026-03-02T10:00:00Z'), externalPaymentRef: 'inv-2' }),
    // Same NEW customer as the first, at the same time: found under the lock, not refused.
    recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: ' c-a ', amountMinor: 800, receivedAt: d('2026-03-03T10:00:00Z'), externalPaymentRef: 'inv-3' }),
  ]);
  expect(a.customerId).toBe(c.customerId);
  expect(b.customerId).not.toBe(a.customerId);
  // c-a = customer 1 (tier); c-b = customer 2 = switch (percent); c-a's second payment after the switch (percent).
  expect(await commissions()).toEqual(['inv-1:TIER:300:PENDING:v1', 'inv-2:PERCENT:80:PENDING:v1', 'inv-3:PERCENT:80:PENDING:v1']);
});

test('refusals carry their codes', { tag: '@smoke' }, async () => {
  const at = d('2026-03-05T00:00:00Z');
  expect(await codeOf(recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-a', amountMinor: 800, receivedAt: at, externalPaymentRef: 'INV-1 ' }))).toBe('duplicate_payment');
  expect(await codeOf(recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-zz', amountMinor: 800, receivedAt: at, externalPaymentRef: 'inv-2' }))).toBe('duplicate_payment');
  expect(await codeOf(recordAffiliatePayment({ ...base(), partnerId: otherId, customerExternalRef: 'c-a', amountMinor: 800, receivedAt: at, externalPaymentRef: 'inv-9' }))).toBe('customer_of_another_partner');
  expect(await codeOf(recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-a', amountMinor: 800, receivedAt: d('2099-01-01T00:00:00Z'), externalPaymentRef: 'inv-8' }))).toBe('invalid_input:received_at');
  expect(await codeOf(recordAffiliatePayment({ ...base(), customerExternalRef: 'c-new', amountMinor: 800, receivedAt: at, externalPaymentRef: 'inv-7' }))).toBe('unknown_customer');
  expect(await codeOf(recordAffiliatePayment({ ...base(), currency: 'XXX', partnerId, customerExternalRef: 'c-a', amountMinor: 800, receivedAt: at, externalPaymentRef: 'inv-6' }))).toBe('currency_mismatch');
  expect(await codeOf(recordAffiliatePayment({ ...base(), partnerId: 'nope', customerExternalRef: 'c-q', amountMinor: 800, receivedAt: at, externalPaymentRef: 'inv-5' }))).toBe('partner_not_found');
  expect(await prisma.affiliatePayment.count({ where: { orgId } })).toBe(3);
  // One audit row per recorded payment, none for a refusal.
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.payment.record' } })).toBe(3);
});

test('a back-dated customer re-orders the partner and moves PENDING rows', { tag: '@smoke' }, async () => {
  const r = await recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-early', amountMinor: 800, receivedAt: d('2026-02-20T10:00:00Z'), externalPaymentRef: 'inv-0' });
  expect([r.created, r.updated, r.removed]).toEqual([1, 1, 0]);
  expect(await commissions()).toEqual(['inv-0:TIER:300:PENDING:v1', 'inv-1:PERCENT:80:PENDING:v1', 'inv-2:PERCENT:80:PENDING:v1', 'inv-3:PERCENT:80:PENDING:v1']);
});

test('a plan change freezes what exists and pays nothing retroactively', { tag: '@smoke' }, async () => {
  await prisma.affiliateCommission.updateMany({ where: { orgId, payment: { externalPaymentRef: 'inv-0' } }, data: { status: 'APPROVED' } });
  // v2: a richer tier and a higher percent. Every payment so far was recorded before it.
  await prisma.affiliateProgramSettings.update({
    where: { orgId },
    data: { planVersion: 2, planEffectiveAt: new Date(), plan: { ...PLAN, percentBps: 2_000, tiers: [{ upToMinor: 1_000, commissionMinor: 333 }] } },
  });
  const rs = await resyncPartnerCommissions(orgId, partnerId);
  expect([rs.created, rs.updated, rs.removed]).toEqual([0, 0, 0]);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.commissions.resync' } })).toBe(1);
  expect(rs.drift.map((x) => `${x.status}:${x.expected?.amountMinor}`).sort()).toEqual(['APPROVED:333', 'PENDING:160', 'PENDING:160', 'PENDING:160']);
  expect(await commissions()).toEqual(['inv-0:TIER:300:APPROVED:v1', 'inv-1:PERCENT:80:PENDING:v1', 'inv-2:PERCENT:80:PENDING:v1', 'inv-3:PERCENT:80:PENDING:v1']);

  // A payment recorded after the change is judged by the new plan.
  await recordAffiliatePayment({ ...base(), partnerId, customerExternalRef: 'c-b', amountMinor: 800, receivedAt: d('2026-03-10T10:00:00Z'), externalPaymentRef: 'inv-10' });
  expect((await commissions()).at(-1)).toBe('inv-10:PERCENT:160:PENDING:v2');
});

test('a suspended partner gets no new payments', { tag: '@smoke' }, async () => {
  await prisma.affiliatePartner.update({ where: { id: partnerId }, data: { status: 'SUSPENDED' } });
  expect(await codeOf(recordAffiliatePayment({ ...base(), customerExternalRef: 'c-a', amountMinor: 800, receivedAt: d('2026-03-11T00:00:00Z'), externalPaymentRef: 'inv-11' }))).toBe('partner_suspended');
});
