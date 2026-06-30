import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin board can search cards and hide empty stages', async ({ page }) => {
  const adminEmail = uniqueEmail('bf-admin');
  const mentorEmail = uniqueEmail('bf-mentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'BF Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'BF Mentor');
  const mentee = await seedUser(uniqueEmail('bf-mentee'), 'x', 'MENTEE', 'Findable Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/board');
    await expect(page.getByText('Findable Mentee')).toBeVisible({ timeout: 10_000 });

    // Hide empty stages collapses columns without cards.
    await page.getByLabel(/Hide empty stages/i).check();
    await expect(page.getByText('Findable Mentee')).toBeVisible();

    // Search filters cards out.
    await page.getByPlaceholder(/Find a mentee or mentor/i).fill('zzz-no-match');
    await expect(page.getByText('Findable Mentee')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
