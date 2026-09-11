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

test('a MARKETING admin sees "Leads"; an INTERNSHIP admin sees "Candidates"', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  const intn = await adminIn('INTERNSHIP');
  try {
    // MARKETING: the candidates page reads "Leads".
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    // The sidebar link is relabelled too.
    await expect(page.locator('aside nav').first().getByRole('link', { name: 'Leads', exact: true })).toBeVisible();
    // And the internship word is gone from this page's heading.
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toHaveCount(0);

    // INTERNSHIP: the same page still reads "Candidates" — the overlay is a no-op.
    await signInAndSettle(page, intn.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toHaveCount(0);
  } finally {
    for (const x of [mkt, intn]) {
      await cleanupByEmail(x.email);
      await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
    }
  }
});
