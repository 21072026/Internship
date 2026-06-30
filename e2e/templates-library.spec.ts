import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC #357: multilingual document templates with in-app preview.
test('mentee can preview a template and switch its language', async ({ page }) => {
  const email = uniqueEmail('tpl-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Template Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/profile');

    // Open the CV template preview.
    const row = page.getByTestId('tpl-cv');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Default locale is EN in the test runner → English heading rendered.
    await expect(dialog.getByRole('heading', { name: /Curriculum Vitae/i })).toBeVisible();

    // Switch to German and confirm the content re-renders.
    await dialog.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: /Lebenslauf/i })).toBeVisible();

    // Export actions are present (PDF / TXT / MD).
    await expect(dialog.getByRole('button', { name: /Save as PDF|PDF/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '.txt' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '.md' })).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
