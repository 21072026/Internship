import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a skip-to-content link targets the main landmark', async ({ page }) => {
  const email = uniqueEmail('a11y');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'A11y Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const skip = page.locator('a[href="#main-content"]');
    await expect(skip).toHaveCount(1);
    await expect(page.locator('#main-content')).toHaveCount(1);
    // It becomes visible on keyboard focus.
    await skip.focus();
    await expect(skip).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

// The lightweight half of the a11y gate (#862): one public page, no login, no
// baseline bookkeeping — just "did we ship a critical violation on the page
// every visitor sees first?". The nine-page role scan (e2e/a11y-scan.spec.ts)
// stays in the scheduled full suite so the PR gate keeps its ~15-20 tests.
test('the sign-in page has no critical accessibility violations', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/auth/signin');
  await page.waitForLoadState('domcontentloaded');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const critical = results.violations
    .filter((v) => v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ') ?? ''}`);
  expect(critical, 'Critical accessibility violations on /auth/signin').toEqual([]);
});
