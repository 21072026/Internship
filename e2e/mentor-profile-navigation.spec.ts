import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the mentor sidebar links to the profile and marks the page you are on', async ({ browser }) => {
  const email = uniqueEmail('mentor-profile-nav');
  const password = 'MentorProfileNav123';
  await seedUser(email, password, 'MENTOR', 'Profile Navigation Mentor');
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await signInAsFreshUser(page, email, password, '/mentor');

    const nav = page.locator('nav');
    const profileLink = nav.locator('a[href="/mentor/profile"]');
    await expect(profileLink).toBeVisible();
    // The dashboard is the current page, so it — and only it — is marked.
    await expect(nav.locator('a[href="/mentor"]')).toHaveAttribute('aria-current', 'page');
    await expect(profileLink).not.toHaveAttribute('aria-current', 'page');

    // Everything the mentor shell offered before the nav became a component is
    // still there — /todos in particular, which is easy to lose in a refactor.
    await expect(nav.locator('a[href="/todos"]')).toBeVisible();
    await expect(nav.locator('a[href="/mentor/mentees"]')).toBeVisible();
    await expect(nav.locator('a[href="/mentor/analytics"]')).toBeVisible();

    await profileLink.click();
    await page.waitForURL('**/mentor/profile');
    await expect(nav.locator('a[href="/mentor/profile"]')).toHaveAttribute('aria-current', 'page');
    // "/mentor" is prefix-matched by every mentor route; only the exact path counts.
    await expect(nav.locator('a[href="/mentor"]')).not.toHaveAttribute('aria-current', 'page');
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});
