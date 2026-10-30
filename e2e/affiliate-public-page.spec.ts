import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { MARKETING_HOST, asHost } from './helpers/auth';

// The public partner-programme page (docs/affiliate-module.md, #3360).
//
// What this pins:
//   1. on the marketing host the org that claims the host (`publicHost`) shows its
//      own copy, a commission table built from ITS plan, and doors that lead to
//      the application form, the partner portal, the product's sign-up page, a
//      phone call, an e-mail and this host's legal pages;
//   2. no copy saved yet → 404, never a half-empty page; the internship host → 404.
//
// Serial and host-borrowing, like e2e/marketing-demo-form.spec.ts: `publicHost`
// is unique, so whoever held MARKETING_HOST before gets it back in afterAll.
// SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const stamp = `${Date.now()}-${Math.round(performance.now())}`;
let orgId = '';
let previousHolderId: string | null = null;

const PLAN = {
  currency: 'EUR',
  tiers: [
    { upToMinor: 2_000, commissionMinor: 5_000 },
    { upToMinor: 5_000, commissionMinor: 10_000 },
  ],
  topCommissionMinor: 15_000,
  percentBps: 1_000,
  switchAtCustomer: 3,
  boundaryCustomer: 'PERCENT',
  windowMonths: 6,
  payoutDays: 30,
  afterNotice: 'RUN_OUT',
};
const LANDING = {
  copy: {
    en: {
      heroTitle: 'Acme Sales partner programme',
      intro: 'Synthetic introduction for a test run.',
      steps: [{ title: 'Apply', text: 'Tell us about you.' }],
      bullets: ['Free to join'],
    },
  },
  phone: '+49 30 1234567',
  email: 'partners@acme.example',
  productSignupUrl: 'https://app.acme.example/register',
};

test.beforeAll(async () => {
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('aff-public-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  orgId = (
    await prisma.organization.create({
      data: { name: `Acme Sales ${stamp}`, slug: `aff-public-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST },
    })
  ).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
});

test.afterAll(async () => {
  if (orgId) {
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  }
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`affiliate-public-page: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
  await prisma.$disconnect();
});

test('without saved copy the page does not exist', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  expect((await page.goto('/partner'))?.status()).toBe(404);
});

test('the marketing host shows the org’s copy, a table from its plan and every door', async ({ page }) => {
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { landing: LANDING } });
  await page.context().setExtraHTTPHeaders({ ...asHost(MARKETING_HOST), 'accept-language': 'en' });
  const res = await page.goto('/partner');
  expect(res?.status()).toBe(200);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Acme Sales partner programme');
  await expect(page.getByText('Synthetic introduction for a test run.')).toBeVisible();

  const rows = page.getByTestId('partner-commission-table').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('20');
  await expect(rows.nth(0)).toContainText('50');
  await expect(rows.nth(2)).toContainText('150');
  await expect(page.getByTestId('partner-percent')).toContainText('3');
  // The plan's boundary customer earns the percent (PERCENT): no "still earns its one-off commission" clause.
  await expect(page.getByTestId('partner-percent')).not.toContainText('one-off');
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: { ...PLAN, boundaryCustomer: 'TIER' } } });
  await page.reload();
  await expect(page.getByTestId('partner-percent')).toContainText('one-off commission from the table');
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: PLAN } });

  await expect(page.getByTestId('partner-apply')).toHaveAttribute('href', '/partner/apply');
  await expect(page.getByTestId('partner-cta-apply')).toHaveAttribute('href', '/partner/apply');
  await expect(page.getByTestId('partner-portal')).toHaveAttribute('href', /\/auth\/signin\?callbackUrl=%2Faffiliate$/);
  await expect(page.getByTestId('partner-product-signup')).toHaveAttribute('href', 'https://app.acme.example/register');
  await expect(page.getByTestId('partner-call')).toHaveAttribute('href', 'tel:+49301234567');
  await expect(page.getByTestId('partner-contact-mail')).toHaveAttribute('href', 'mailto:partners@acme.example');
  for (const href of ['/imprint', '/privacy', '/terms']) await expect(page.locator(`footer a[href="${href}"]`)).toHaveCount(1);
});

test('the internship host has no partner page', async ({ page }) => {
  expect((await page.goto('/partner'))?.status()).toBe(404);
});
