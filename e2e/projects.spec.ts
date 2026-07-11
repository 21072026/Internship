import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor can create and see a project they own', async ({ page }) => {
  const email = uniqueEmail('proj-mentor');
  const mentor = await seedUser(email, 'MentorPass123', 'MENTOR', 'Proj Mentor');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/projects');
    // Card-first screen (#615): no form on load; it opens via "Add project".
    await expect(page.getByTestId('add-project')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/^Name/)).toHaveCount(0);
    await page.getByTestId('add-project').click();
    await page.getByLabel(/^Name/).fill('Community Bot');
    await page.getByLabel(/Technologies/).fill('Python, Docker');
    const done = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create' }).click();
    await done;

    await expect(page.getByText('Community Bot')).toBeVisible({ timeout: 10_000 });
    const proj = await prisma.project.findFirst({ where: { ownerUserId: mentor.id } });
    expect(proj?.ownerType).toBe('MENTOR');
  } finally {
    await prisma.project.deleteMany({ where: { ownerUserId: mentor.id } });
    await cleanupByEmail(email);
  }
});

test('a project requires a valid owner (no orphans)', async ({ page }) => {
  const adminEmail = uniqueEmail('proj-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Proj Admin');
  const company = await prisma.company.create({ data: { name: 'Proj Co' } });
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // COMPANY owner without a company id → rejected.
    const bad = await page.request.post('/api/projects', { data: { name: 'Orphan', ownerType: 'COMPANY' } });
    expect(bad.status()).toBe(400);

    // With a real company → created and owned by it.
    const ok = await page.request.post('/api/projects', { data: { name: 'Co Project', ownerType: 'COMPANY', ownerCompanyId: company.id } });
    expect(ok.status()).toBe(201);
    const proj = await prisma.project.findFirst({ where: { ownerCompanyId: company.id } });
    expect(proj?.ownerType).toBe('COMPANY');
  } finally {
    await prisma.project.deleteMany({ where: { ownerCompanyId: company.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await cleanupByEmail(adminEmail);
  }
});
