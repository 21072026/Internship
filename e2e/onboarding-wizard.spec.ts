import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('onboarding wizard prefills the name and offers a wide graduation-year range', async ({ page }) => {
  const email = uniqueEmail('wizard');
  await seedUser(email, 'WizardPass123!', 'MENTEE', 'Wizard Prefill User');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'WizardPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/onboarding');
    // #141: full name is prefilled from registration.
    await expect(page.getByLabel(/Full Name/i)).toHaveValue('Wizard Prefill User', { timeout: 10_000 });

    // Advance to step 2 and check the year range (#142): a pre-2020 year exists.
    await page.getByRole('button', { name: /Continue/i }).click();
    const yearSelect = page.getByLabel(/Graduation Year/i);
    await expect(yearSelect).toBeVisible({ timeout: 10_000 });
    // pre-2020 is now selectable; the old fixed 2035 cap is gone.
    await expect(yearSelect.locator('option[value="2015"]')).toHaveCount(1);
    await expect(yearSelect.locator('option[value="2010"]')).toHaveCount(1);
  } finally {
    await cleanupByEmail(email);
  }
});
