import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// The public partner application (docs/affiliate-module.md, #3361).
//
// What this pins:
//   1. a valid application on the marketing host lands in the org that claims the
//      host, with the consent record, and that org's admins are told in the app;
//      the internship host's form is closed (503) and writes nothing; @smoke —
//      a sessionless write must land in exactly one tenant;
//   2. refused fields are named; an address with a pending application, a filled
//      honeypot and an over-fast submit all answer the same 200 and write nothing;
//   3. the form page exists where the programme exists.
//
// Serial and host-borrowing, like e2e/marketing-demo-form.spec.ts. Every request
// gets its own client address (freshIp): the route's limit is 3/hour per IP.
// SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const stamp = `${Date.now()}-${Math.round(performance.now())}`;
let orgId = '';
let adminId = '';
let progAdminId = '';
let previousHolderId: string | null = null;
const adminEmail = uniqueEmail('aff-apply-admin');
const progAdminEmail = uniqueEmail('aff-apply-progadmin');
const applicant = `applicant-${stamp}@partner.example`;


const PLAN = {
  currency: 'EUR',
  tiers: [],
  topCommissionMinor: 5_000,
  percentBps: 0,
  switchAtCustomer: null,
  boundaryCustomer: 'TIER',
  windowMonths: null,
  payoutDays: 30,
  afterNotice: 'STOP_ALL',
};
const valid = {
  firstName: 'Ada',
  lastName: 'Example',
  email: applicant,
  heardFrom: 'recommendation',
  consent: true,
  renderedAt: Date.now() - 60_000,
  locale: 'de',
};

test.beforeAll(async () => {
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('aff-apply-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  orgId = (
    await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-apply-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST } })
  ).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  adminId = (await seedUser(adminEmail, 'AffApply123!', 'ADMIN', 'Apply Admin', { orgId })).id;
  // A PROGRAM_ADMIN without a grant may not read the programme, so it is not told either.
  progAdminId = (await seedUser(progAdminEmail, 'AffApply123!', 'ADMIN', 'Program Admin', { orgId })).id;
  await prisma.user.update({ where: { id: progAdminId }, data: { adminLevel: 'PROGRAM_ADMIN' } });
});

test.afterAll(async () => {
  if (orgId) {
    await prisma.affiliateApplication.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
  }
  await cleanupByEmail(adminEmail);
  await cleanupByEmail(progAdminEmail);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`affiliate-application: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
  await prisma.$disconnect();
});

test('an application lands in the host’s org only; the internship host is closed', { tag: '@smoke' }, async ({ request }) => {
  const closed = await request.post('/api/partner/apply', { headers: freshIp('affiliate-application'), data: valid });
  expect(closed.status()).toBe(503);
  expect(await prisma.affiliateApplication.count({ where: { email: applicant } })).toBe(0);

  const res = await request.post('/api/partner/apply', { headers: { ...asHost(MARKETING_HOST), ...freshIp('affiliate-application') }, data: valid });
  expect(res.status()).toBe(200);
  const rows = await prisma.affiliateApplication.findMany({ where: { email: applicant } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ orgId, firstName: 'Ada', status: 'PENDING', heardFrom: 'recommendation', locale: 'de' });
  expect(rows[0].consentTextVersion).toBeTruthy();
  // The notice is sent after the response (no timing difference between outcomes).
  await expect.poll(() => prisma.notification.count({ where: { userId: adminId, type: 'affiliate_application.new' } }), { timeout: 15_000 }).toBe(1);
  expect(await prisma.notification.count({ where: { userId: progAdminId, type: 'affiliate_application.new' } })).toBe(0);
});

test('refused fields are named; duplicates, honeypot and instant submits write nothing', async ({ request }) => {
  const bad = await request.post('/api/partner/apply', { headers: { ...asHost(MARKETING_HOST), ...freshIp('affiliate-application') }, data: { ...valid, email: 'nope', heardFrom: 'tv', consent: false } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).fields).toEqual(['email', 'heardFrom', 'consent']);

  // The same address while its application is pending: same answer, no second row.
  expect((await request.post('/api/partner/apply', { headers: { ...asHost(MARKETING_HOST), ...freshIp('affiliate-application') }, data: valid })).status()).toBe(200);
  expect(await prisma.affiliateApplication.count({ where: { email: applicant } })).toBe(1);

  const other = `other-${stamp}@partner.example`;
  expect((await request.post('/api/partner/apply', { headers: { ...asHost(MARKETING_HOST), ...freshIp('affiliate-application') }, data: { ...valid, email: other, website: 'https://spam.example' } })).status()).toBe(200);
  expect((await request.post('/api/partner/apply', { headers: { ...asHost(MARKETING_HOST), ...freshIp('affiliate-application') }, data: { ...valid, email: other, renderedAt: Date.now() } })).status()).toBe(200);
  expect(await prisma.affiliateApplication.count({ where: { email: other } })).toBe(0);
});

test('the form page exists where the programme exists', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  expect((await page.goto('/partner/apply'))?.status()).toBe(200);
  await expect(page.getByTestId('affiliate-apply-form')).toBeVisible();
  await page.context().setExtraHTTPHeaders({});
  expect((await page.goto('/partner/apply'))?.status()).toBe(404);
});
