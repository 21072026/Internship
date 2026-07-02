import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Regression for EPIC H: /admin/mentorship used to fetch every relation and
// paginate client-side. This verifies the server now paginates (20/page) and
// that search narrows the result set server-side too.
test('mentorships list paginates server-side and search narrows results', async ({ page }) => {
  const adminEmail = uniqueEmail('mpag-admin');
  const mentorEmail = uniqueEmail('mpag-mentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'MPag Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'MPag Mentor');

  const prefix = `MPagMentee${Date.now().toString(36)}`;
  const menteeEmails: string[] = [];
  const relationIds: string[] = [];
  const COUNT = 22; // one more than PAGE_SIZE (20)

  try {
    for (let i = 0; i < COUNT; i++) {
      const email = uniqueEmail(`mpag-mentee-${i}`);
      menteeEmails.push(email);
      const mentee = await seedUser(email, 'x', 'MENTEE', `${prefix} ${i}`);
      const rel = await prisma.mentorshipRelation.create({
        data: { mentorId: mentor.id, menteeId: mentee.id },
      });
      relationIds.push(rel.id);
    }

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/mentorship');
    await page.getByPlaceholder(/mentor, mentee/i).fill(prefix);

    // Page 1 shows exactly PAGE_SIZE (20) of the 22 matching relations.
    await expect(page.locator('[data-testid^="mentorship-row-"]')).toHaveCount(20, { timeout: 10_000 });
    await expect(page.getByText('1 / 2')).toBeVisible();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('[data-testid^="mentorship-row-"]')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByText('2 / 2')).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relationIds } } });
    for (const email of menteeEmails) await cleanupByEmail(email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
