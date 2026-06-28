import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('visiting a public profile increments its view count', async ({ page }) => {
  const email = uniqueEmail('pvcount');
  const user = await seedUser(email, 'Pass123Aa', 'MENTEE', 'Viewed Person');
  await prisma.user.update({ where: { id: user.id }, data: { publicProfile: true } });

  try {
    await page.goto(`/p/${user.id}`); // anonymous visitor
    await expect(page.getByRole('heading', { name: 'Viewed Person' })).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))!.profileViews, { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('admin analytics dashboard renders the pipeline funnel', async ({ page }) => {
  const adminEmail = uniqueEmail('anaadmin');
  const mentorEmail = uniqueEmail('anamentor');
  const menteeEmail = uniqueEmail('anamentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Analytics Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Ana Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Ana Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'HIRED_660' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/analytics');
    await expect(page.getByText('Pipeline funnel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Mentor workload & outcomes')).toBeVisible();
    await expect(page.getByText('Ana Mentor')).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
