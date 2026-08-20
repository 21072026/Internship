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
    const trigger = row.getByRole('button');
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogButtons = dialog.getByRole('button');

    // #871: opening moves focus inside, and both directions wrap at the
    // boundaries instead of reaching controls behind the modal.
    await expect(dialog.getByRole('button', { name: 'EN', exact: true })).toBeFocused();
    const buttonCount = await dialogButtons.count();
    for (let i = 0; i < buttonCount && !(await dialogButtons.last().evaluate((element) => element === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(dialogButtons.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialogButtons.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialogButtons.last()).toBeFocused();

    // Default locale is EN in the test runner → English body heading rendered.
    // Target the rendered body H1 (level 1); the modal title is a separate H2.
    await expect(dialog.getByRole('heading', { level: 1, name: 'Curriculum Vitae' })).toBeVisible();

    // Switch to German and confirm the content re-renders.
    await dialog.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(dialog.getByRole('heading', { level: 1, name: 'Lebenslauf' })).toBeVisible();

    // Export actions are present (PDF / TXT / MD).
    await expect(dialog.getByRole('button', { name: /Save as PDF|PDF/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '.txt' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '.md' })).toBeVisible();

    // Escape uses the ordinary close path and returns focus to the opener.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await cleanupByEmail(email);
  }
});
