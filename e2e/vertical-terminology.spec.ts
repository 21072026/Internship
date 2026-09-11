import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Vertical terminology overlay in the live UI (#2354, epic #2348). A MARKETING
// admin sees "Leads" where an INTERNSHIP admin sees "Candidates" — same page,
// different vocabulary, driven only by Organization.vertical. INTERNSHIP is a
// strict no-op (the overlay is empty), asserted here so the change is provably
// invisible to today's product.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function adminIn(vertical: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Term ${vertical} ${stamp}`, slug: `term-${stamp}`, vertical },
  });
  const email = uniqueEmail(`term-${vertical.toLowerCase()}`);
  const admin = await seedUser(email, 'TermPass123', 'ADMIN', `${vertical} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

test('a MARKETING admin sees "Leads" on the candidates page and in the nav', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  try {
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    await expect(page.locator('aside nav').first().getByRole('link', { name: 'Leads', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toHaveCount(0);
  } finally {
    await cleanupByEmail(mkt.email);
    await prisma.organization.delete({ where: { id: mkt.org.id } }).catch(() => {});
  }
});

test('an INTERNSHIP admin still sees "Candidates" — the overlay is a no-op', async ({ page }) => {
  const intn = await adminIn('INTERNSHIP');
  try {
    await signInAndSettle(page, intn.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toHaveCount(0);
  } finally {
    await cleanupByEmail(intn.email);
    await prisma.organization.delete({ where: { id: intn.org.id } }).catch(() => {});
  }
});
