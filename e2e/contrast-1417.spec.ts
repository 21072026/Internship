import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

const password = 'Contrast1417Pass!';

async function forceTheme(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.evaluate((theme) => {
    document.cookie = `theme=${theme}; path=/; max-age=31536000`;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, dark ? 'dark' : 'light');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

async function expectNoContrastViolation(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.filter((violation) => violation.id === 'color-contrast')).toEqual([]);
}

test('issue #1417 calendar and onboarding targets meet AA contrast in both themes', async ({ page }) => {
  const email = uniqueEmail('contrast-1417');
  const user = await seedUser(email, password, 'MENTEE', 'Contrast Mentee');
  try {
    await signInAsFreshUser(page, email, password, '/portal');

    for (const dark of [false, true]) {
      await page.goto('/portal/calendar');
      await forceTheme(page, dark);
      await expect(page.locator('[data-testid="calendar-day-number"][data-outside-month="false"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="calendar-day-number"][data-outside-month="true"]').first()).toBeVisible();
      await expectNoContrastViolation(page, '[data-testid="calendar-day-number"]');
      await expectNoContrastViolation(page, '[role="tab"][aria-selected="false"]');
      await expectNoContrastViolation(page, '[role="tab"][aria-selected="true"]');

      await page.goto('/onboarding');
      await forceTheme(page, dark);
      await expect(page.locator('[data-testid="onboarding-step-label"][data-step-state="inactive"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="onboarding-step-badge"][data-step-state="future"]').first()).toBeVisible();
      await expectNoContrastViolation(page, '[data-testid="onboarding-step-label"][data-step-state="inactive"]');
      await expectNoContrastViolation(page, '[data-testid="onboarding-step-badge"][data-step-state="future"]');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.$disconnect();
  }
});
