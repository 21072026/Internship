import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

test('mentee can upload, view and delete their CV', async ({ page }) => {
  const email = uniqueEmail('cvmentee');
  const user = await seedUser(email, 'MenteePass123!', 'MENTEE', 'CV Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/profile');

    // Upload a CV via the hidden file input.
    const uploaded = page.waitForResponse(
      (r) => r.url().endsWith('/api/cv') && r.request().method() === 'POST'
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cv.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await uploaded;

    await expect(page.getByRole('link', { name: 'View CV' })).toBeVisible({ timeout: 10_000 });
    const cv = await prisma.cvFile.findUnique({ where: { userId: user.id } });
    expect(cv).not.toBeNull();
    expect(cv!.contentType).toBe('application/pdf');

    // Delete it.
    const removed = page.waitForResponse(
      (r) => r.url().includes(`/api/cv/${user.id}`) && r.request().method() === 'DELETE'
    );
    await page.getByRole('button', { name: 'Delete' }).click();
    await removed;
    await expect(page.getByText('No CV uploaded')).toBeVisible({ timeout: 10_000 });

    const after = await prisma.cvFile.findUnique({ where: { userId: user.id } });
    expect(after).toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});
