import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor profile navigation and completion reminder follow profile state and browser session', async ({ browser }) => {
  const email = uniqueEmail('mentor-profile-nav');
  const password = 'MentorProfileNav123';
  const mentor = await seedUser(email, password, 'MENTOR', 'Profile Navigation Mentor');
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await signInAsFreshUser(page, email, password, '/mentor');

    const profileLink = page.locator('nav a[href="/mentor/profile"]');
    const banner = page.getByTestId('mentor-profile-completion-banner');
    await expect(profileLink).toBeVisible();
    await expect(banner).toBeVisible(); // bio is empty

    await prisma.user.update({
      where: { id: mentor.id },
      data: { bio: 'Complete biography', interests: '   ', mentorCapacity: 1 },
    });
    await page.reload();
    await expect(banner).toBeVisible(); // interests is whitespace-only

    await prisma.user.update({
      where: { id: mentor.id },
      data: { interests: 'Architecture', mentorCapacity: null },
    });
    await page.reload();
    await expect(banner).toBeVisible(); // capacity is null

    await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 0 } });
    await page.reload();
    await expect(banner).toHaveCount(0); // zero is a valid capacity

    await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 3 } });
    await page.reload();
    await expect(banner).toHaveCount(0); // all three fields are complete

    await prisma.user.update({ where: { id: mentor.id }, data: { bio: null } });
    await page.reload();
    await expect(banner).toBeVisible();
    await banner.getByRole('button').click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(banner).toHaveCount(0); // dismissed for this browser session

    await page.evaluate(() => sessionStorage.removeItem('mentor-profile-completion-banner-dismissed'));
    await page.reload();
    await banner.locator('a[href="/mentor/profile"]').click();
    await page.waitForURL('**/mentor/profile');
    await expect(page.locator('nav a[href="/mentor/profile"]')).toHaveAttribute('aria-current', 'page');

    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      await signInAsFreshUser(freshPage, email, password, '/mentor');
      await expect(freshPage.getByTestId('mentor-profile-completion-banner')).toBeVisible();
    } finally {
      await freshContext.close();
    }
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});
