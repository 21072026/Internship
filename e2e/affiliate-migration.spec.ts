import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { recordAffiliatePayment } from '../src/lib/affiliatePaymentWriter';

/**
 * Taking over a previous system's affiliate history (docs/affiliate-module.md, #3118).
 *
 * A dry run and the real run produce the same plan; the real run writes the set
 * whole, in one transaction, into an empty programme only, and a reconciliation
 * difference of one cent writes nothing. Imported commissions are frozen as
 * recorded — a later plan change does not recompute them — while their customers
 * still count for the next customer's position. @smoke: money, all-or-nothing.
 *
 * SYNTHETIC ONLY: invented codes, references and amounts; throwaway MARKETING orgs.
 */

const PW = 'AffMigrate123!';
const host = asHost(MARKETING_HOST);
const orgIds: string[] = [];
const emails: string[] = [];
const contexts: APIRequestContext[] = [];
let ownerEmail = '';
let observerEmail = '';
let orgId = '';

const PARTNERS = `code;name;email;status;ended_on;paid_total;unpaid_total
1042;Synthetic One;one@example.test;ACTIVE;;35,00;12,50
spark-co;Spark Co;;TERMINATED;2026-06-30;0;7,00
`;
const COMMISSIONS = `partner_code,customer_ref,payment_ref,payment_amount,payment_date,commission_amount,status,due_date,payout_ref
1042,CUST-A,PAY-1,100.00,2026-01-10,20.00,PAID,2026-02-09,PO-1
1042,CUST-A,PAY-2,100.00,2026-02-10,15.00,PAID,2026-03-12,PO-1
1042,CUST-B,PAY-3,50.00,2026-03-01,12.50,APPROVED,,
1042,CUST-B,PAY-4,50.00,2026-04-01,9.99,REJECTED,,
SPARK-CO,CUST-C,PAY-5,70.00,2026-05-05,7.00,PENDING,2026-06-04,
`;
const PAYOUTS = `payout_ref,partner_code,amount,paid_date,bank_reference
PO-1,1042,"35,00",2026-03-20,TRX 0001
`;

// The 3rd customer onwards earns a percentage; the imported customers are the first two.
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 100_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: 3,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};

async function newOrg(label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const id = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-mig-${label}-${stamp}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  return id;
}

async function adminOf(org: string, level: 'ORG_ADMIN' | 'OBSERVER' = 'ORG_ADMIN') {
  const email = uniqueEmail(`aff-mig-${level.toLowerCase()}`);
  emails.push(email);
  const user = await seedUser(email, PW, 'ADMIN', 'Migration Admin', { orgId: org });
  if (level === 'OBSERVER') await prisma.user.update({ where: { id: user.id }, data: { adminLevel: 'OBSERVER' } });
  return email;
}

async function signedIn(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
  return ctx;
}

const migrate = (ctx: APIRequestContext, data: Record<string, unknown>) =>
  ctx.post('/api/admin/affiliate/migration', { headers: host, data: { partners: PARTNERS, commissions: COMMISSIONS, payouts: PAYOUTS, ...data } });

const writtenRows = async (org: string) => ({
  partners: await prisma.affiliatePartner.count({ where: { orgId: org } }),
  payments: await prisma.affiliatePayment.count({ where: { orgId: org } }),
  commissions: await prisma.affiliateCommission.count({ where: { orgId: org } }),
  payouts: await prisma.affiliatePayout.count({ where: { orgId: org } }),
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = await newOrg('main');
  ownerEmail = await adminOf(orgId);
  observerEmail = await adminOf(orgId, 'OBSERVER');
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('a dry run and the real run agree; the real run writes the set whole, once', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const observer = await signedIn(playwright, baseURL, observerEmail);
  expect((await migrate(observer, {})).status()).toBe(403);

  const owner = await signedIn(playwright, baseURL, ownerEmail);
  const dry = await (await migrate(owner, {})).json();
  expect(dry).toMatchObject({ dryRun: true, written: false, blocked: null, issueCount: 0 });
  expect(dry.counts).toEqual({ partners: 2, customers: 3, payments: 5, commissions: 5, payouts: 1 });
  expect(await writtenRows(orgId)).toEqual({ partners: 0, payments: 0, commissions: 0, payouts: 0 });

  const real = await (await migrate(owner, { dryRun: false })).json();
  expect(real).toMatchObject({ dryRun: false, written: true, blocked: null, issueCount: 0 });
  // The same plan: the same reconciliation and the same counts.
  expect(real.reconciliation).toEqual(dry.reconciliation);
  expect(real.counts).toEqual(dry.counts);
  expect(await writtenRows(orgId)).toEqual({ partners: 2, payments: 5, commissions: 5, payouts: 1 });

  // As recorded: codes verbatim, statuses, amounts, the payout, kind and source.
  const partners = await prisma.affiliatePartner.findMany({ where: { orgId }, orderBy: { code: 'asc' }, select: { code: true, status: true, userId: true, noticeEffectiveAt: true } });
  expect(partners.map((p) => [p.code, p.status, p.userId, p.noticeEffectiveAt?.toISOString() ?? null])).toEqual([
    ['1042', 'ACTIVE', null, null],
    ['spark-co', 'TERMINATED', null, '2026-06-30T00:00:00.000Z'],
  ]);
  const commissions = await prisma.affiliateCommission.findMany({
    where: { orgId },
    orderBy: { accruedAt: 'asc' },
    select: { kind: true, amountMinor: true, status: true, planVersion: true, payoutId: true, payment: { select: { externalPaymentRef: true, source: true } } },
  });
  expect(commissions.map((c) => [c.payment.externalPaymentRef, c.kind, c.amountMinor, c.status, c.planVersion, c.payment.source, c.payoutId !== null])).toEqual([
    ['PAY-1', 'IMPORTED', 2000, 'PAID', 0, 'IMPORT', true],
    ['PAY-2', 'IMPORTED', 1500, 'PAID', 0, 'IMPORT', true],
    ['PAY-3', 'IMPORTED', 1250, 'APPROVED', 0, 'IMPORT', false],
    ['PAY-4', 'IMPORTED', 999, 'REJECTED', 0, 'IMPORT', false],
    ['PAY-5', 'IMPORTED', 700, 'PENDING', 0, 'IMPORT', false],
  ]);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.migration.run' } })).toBe(1);

  // Once: the programme now holds data.
  const again = await (await migrate(owner, { dryRun: false })).json();
  expect(again).toMatchObject({ written: false, blocked: 'not_empty' });
  expect(await writtenRows(orgId)).toEqual({ partners: 2, payments: 5, commissions: 5, payouts: 1 });
});

test('imported commissions stay as recorded; their customers still count', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await signedIn(playwright, baseURL, ownerEmail);
  expect((await owner.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).status()).toBe(200);

  // The plan change re-evaluated every partner: the imported PENDING row is untouched, no drift.
  const pending = await prisma.affiliateCommission.findFirst({ where: { orgId, status: 'PENDING' }, select: { amountMinor: true, kind: true, planVersion: true } });
  expect(pending).toEqual({ amountMinor: 700, kind: 'IMPORTED', planVersion: 0 });
  const drift = await (await owner.get('/api/admin/affiliate/commissions/drift', { headers: host })).json();
  expect(drift.drift).toEqual([]);

  // A new customer of 1042 is its THIRD (two imported before it) → a percentage.
  const partner = await prisma.affiliatePartner.findFirstOrThrow({ where: { orgId, code: '1042' }, select: { id: true } });
  await recordAffiliatePayment({
    orgId,
    partnerId: partner.id,
    customerExternalRef: 'CUST-NEW',
    amountMinor: 800,
    currency: 'EUR',
    receivedAt: new Date('2026-09-01T00:00:00Z'),
    externalPaymentRef: 'PAY-NEW',
    source: 'MANUAL',
  });
  const fresh = await prisma.affiliateCommission.findFirst({ where: { orgId, payment: { externalPaymentRef: 'PAY-NEW' } }, select: { kind: true, amountMinor: true } });
  expect(fresh).toEqual({ kind: 'PERCENT', amountMinor: 80 });
  expect(await prisma.affiliateCommission.count({ where: { orgId, kind: 'IMPORTED' } })).toBe(5);
});

test('a one-cent difference or a bad row writes nothing', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const other = await newOrg('cent');
  const owner = await signedIn(playwright, baseURL, await adminOf(other));

  const cent = await (await migrate(owner, { dryRun: false, partners: PARTNERS.replace('35,00;12,50', '35,00;12,51') })).json();
  expect(cent).toMatchObject({ written: false, blocked: 'issues' });
  expect(cent.issues).toContainEqual({ file: 'partners', row: 1, code: 'reconciliation', subject: '1042' });
  expect(cent.reconciliation[0]).toMatchObject({ code: '1042', expectedUnpaidMinor: 1251, unpaidMinor: 1250, ok: false });

  const badRow = await (await migrate(owner, { dryRun: false, commissions: COMMISSIONS.replace('2026-05-05', '2026-02-31') })).json();
  expect(badRow).toMatchObject({ written: false, blocked: 'issues' });
  expect(badRow.issues).toContainEqual({ file: 'commissions', row: 5, code: 'invalid_date', subject: 'payment_date' });

  expect(await writtenRows(other)).toEqual({ partners: 0, payments: 0, commissions: 0, payouts: 0 });
});

test('the import screen checks first and imports only what it checked', async ({ page }) => {
  const org = await newOrg('ui');
  const email = await adminOf(org);
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/migration');

  const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.getByTestId('migration-file-partners').setInputFiles(file('partners.csv', PARTNERS));
  await page.getByTestId('migration-file-commissions').setInputFiles(file('commissions.csv', COMMISSIONS));
  await page.getByTestId('migration-file-payouts').setInputFiles(file('payouts.csv', PAYOUTS));
  await expect(page.getByTestId('migration-run')).toBeDisabled();

  await page.getByTestId('migration-check').click();
  await expect(page.getByTestId('migration-reconciliation')).toContainText('spark-co');
  await expect(page.getByTestId('migration-run')).toBeEnabled();
  expect(await writtenRows(org)).toEqual({ partners: 0, payments: 0, commissions: 0, payouts: 0 });

  // Another file after the check: the import is offered again only after a new check.
  await page.getByTestId('migration-file-payouts').setInputFiles(file('payouts.csv', PAYOUTS.replace('TRX 0001', 'TRX 0002')));
  await expect(page.getByTestId('migration-run')).toBeDisabled();
  await page.getByTestId('migration-check').click();
  await expect(page.getByTestId('migration-run')).toBeEnabled();

  await page.getByTestId('migration-run').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByTestId('migration-status')).toContainText('Imported', { timeout: 30_000 });
  expect(await writtenRows(org)).toEqual({ partners: 2, payments: 5, commissions: 5, payouts: 1 });
});
