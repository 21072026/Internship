import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { MARKETING_HOST } from './helpers/auth';

// The marketing price list is per-organization data (#2927): /pricing on a
// marketing host shows the list of the organization bound to that host
// (`Organization.publicHost`, setting `marketingPriceList`). There is no
// built-in list: without one (or with one that does not parse) the page shows
// a neutral "pricing on request" block and no figure at all.
//
// Serial: `publicHost` is unique, so the host is borrowed from whoever holds it
// and given back afterwards (the same dance as marketing-demo-form.spec.ts).

test.describe.configure({ mode: 'serial' });

const stamp = `${Date.now()}-${Math.round(performance.now())}`;
let orgId = '';
let previousHolderId: string | null = null;

const LIST = {
  currency: 'CHF',
  plans: [
    { key: 'team', annualSeatMinor: 4500, monthlySeatMinor: 5500, minSeats: 2, onboardingMinor: 0 },
    { key: 'business', annualSeatMinor: 8990, monthlySeatMinor: null, minSeats: 4, onboardingMinor: 50000 },
  ],
};

test.beforeAll(async () => {
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('price-list-mkt-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  const org = await prisma.organization.create({
    data: { name: `Acme Sales ${stamp}`, slug: `price-list-mkt-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST },
  });
  orgId = org.id;
});

test.afterAll(async () => {
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`marketing-price-list: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
  await prisma.$disconnect();
});

test("the host's organization publishes its own list; without one the page names no price", async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST });

  // Bound, but no list of its own: "pricing on request", no plan cards, no figure.
  await page.goto('/pricing');
  await expect(page.getByTestId('pricing-marketing-on-request')).toBeVisible();
  await expect(page.getByTestId('pricing-marketing-on-request').getByRole('link')).toHaveAttribute('href', '/#demo');
  await expect(page.getByTestId('pricing-marketing-plans')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/€\s?\d|\d\s?€/);

  // The organization's own list: its currency, its plans, nothing else.
  await prisma.setting.create({ data: { orgId, key: 'marketingPriceList', value: JSON.stringify(LIST) } });
  await page.goto('/pricing');
  await expect(page.getByTestId('mkt-plan-team')).toContainText('CHF 45');
  await expect(page.getByTestId('mkt-plan-team')).toContainText('CHF 55');
  await expect(page.getByTestId('mkt-plan-business')).toContainText('CHF 89.90');
  await expect(page.getByTestId('mkt-plan-business')).toContainText('Annual contract only');
  await expect(page.getByTestId('mkt-plan-business')).toContainText('CHF 500');
  await expect(page.getByTestId('mkt-plan-enterprise')).toHaveCount(0);
  await expect(page.getByTestId('pricing-marketing-on-request')).toHaveCount(0);

  // A stored value that does not parse reads as no list, never as a broken page.
  await prisma.setting.updateMany({ where: { orgId, key: 'marketingPriceList' }, data: { value: '{"currency":"EUR","plans":[]}' } });
  await page.goto('/pricing');
  await expect(page.getByTestId('pricing-marketing-on-request')).toBeVisible();
  await expect(page.getByTestId('pricing-marketing-plans')).toHaveCount(0);
});
