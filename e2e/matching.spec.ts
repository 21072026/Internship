import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor suggestions rank by skill overlap; candidate detail shows next action', async ({ page }) => {
  const adminEmail = uniqueEmail('matchadmin');
  const menteeEmail = uniqueEmail('matchmentee');
  const mAEmail = uniqueEmail('mentorA');
  const mBEmail = uniqueEmail('mentorB');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Match Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Match Mentee');
  const mentorA = await seedUser(mAEmail, 'x', 'MENTOR', 'Overlap Mentor');
  const mentorB = await seedUser(mBEmail, 'x', 'MENTOR', 'Other Mentor');
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['React', 'Node.js'] } });
  await prisma.user.update({ where: { id: mentorA.id }, data: { skills: ['React', 'Node.js', 'AWS'] } });
  await prisma.user.update({ where: { id: mentorB.id }, data: { skills: ['Java'] } });
  await prisma.mentorshipRelation.create({ data: { mentorId: mentorA.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get(`/api/admin/suggest-mentors?menteeId=${mentee.id}`);
    expect(res.ok()).toBeTruthy();
    const { suggestions } = await res.json();
    expect(suggestions[0].id).toBe(mentorA.id); // higher skill overlap ranks first

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText('Next action:')).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mAEmail);
    await cleanupByEmail(mBEmail);
    await cleanupByEmail(adminEmail);
  }
});
