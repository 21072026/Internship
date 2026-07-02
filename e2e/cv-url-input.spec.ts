import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #355: the manual "CV URL" field is for an EXTERNAL link only. When the stored
// CV is an uploaded file (internal /api/cv/... path), the field is hidden and the
// CvManager owns it; when empty/external, the field is shown.
test('manual CV URL input hides for an uploaded file CV, shows otherwise', async ({ page }) => {
  const email = uniqueEmail('cvinput-mentee');
  const user = await seedUser(email, 'MenteePass123', 'MENTEE', 'CV Input Mentee');

  const urlInput = page.getByPlaceholder('https://drive.google.com/...');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // No CV yet → the manual external-link input is shown.
    await page.goto('/portal/profile');
    await expect(urlInput).toBeVisible();

    // Simulate an uploaded file CV (internal path) → input hides on next load.
    await prisma.user.update({ where: { id: user.id }, data: { cvUrl: `/api/cv/${user.id}` } });
    await page.goto('/portal/profile');
    await expect(urlInput).toHaveCount(0);

    // An external URL is still managed by the input.
    await prisma.user.update({ where: { id: user.id }, data: { cvUrl: 'https://drive.google.com/file/123' } });
    await page.goto('/portal/profile');
    await expect(urlInput).toHaveValue('https://drive.google.com/file/123');
  } finally {
    await cleanupByEmail(email);
  }
});
