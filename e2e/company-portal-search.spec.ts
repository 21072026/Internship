import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('company portal lists linked candidates and search narrows them', async ({ page }) => {
  const compUserEmail = uniqueEmail('cp-user');
  const mentorEmail = uniqueEmail('cp-mentor');
  const compUser = await seedUser(compUserEmail, 'CompPass123', 'COMPANY', 'CP User');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'CP Mentor');
  const m1 = await seedUser(uniqueEmail('cp-zara'), 'x', 'MENTEE', 'Zara Unique');
  const m2 = await seedUser(uniqueEmail('cp-other'), 'x', 'MENTEE', 'Other Person');
  const company = await prisma.company.create({ data: { name: `Acme ${Date.now()}` } });
  await prisma.user.update({ where: { id: compUser.id }, data: { companyId: company.id } });
  const r1 = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m1.id, companyId: company.id } });
  const r2 = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m2.id, companyId: company.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', compUserEmail);
    await page.fill('input[type="password"]', 'CompPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    await expect(page.getByText('Zara Unique')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Other Person')).toBeVisible();

    await page.getByPlaceholder(/Search by name or university/i).fill('Zara');
    await expect(page.getByText('Zara Unique')).toBeVisible();
    await expect(page.getByText('Other Person')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
    await prisma.user.updateMany({ where: { id: compUser.id }, data: { companyId: null } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await cleanupByEmail(m1.email);
    await cleanupByEmail(m2.email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(compUserEmail);
  }
});
