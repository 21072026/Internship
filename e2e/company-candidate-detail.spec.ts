import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a COMPANY user can open a linked candidate\'s detail page but not an unlinked one', async ({ page }) => {
  const companyEmail = uniqueEmail('co-detail');
  const mentorEmail = uniqueEmail('co-detail-mentor');
  const menteeEmail = uniqueEmail('co-detail-mentee');
  const outsiderEmail = uniqueEmail('co-detail-outsider');
  const pw = 'CompanyPass123!';

  const company = await prisma.company.create({ data: { name: `Detail Co ${Date.now()}` } });
  const companyUser = await prisma.user.create({
    data: {
      email: companyEmail,
      password: await bcrypt.hash(pw, 10),
      role: 'COMPANY',
      fullName: 'Detail Co Observer',
      companyId: company.id,
      skills: [],
    },
  });
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Detail Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Detail Candidate');
  const outsider = await seedUser(outsiderEmail, 'x', 'MENTEE', 'Outsider Candidate');
  await prisma.user.update({
    where: { id: mentee.id },
    data: { university: 'TU Berlin', skills: ['React', 'SQL'], skillLevels: { React: 4 }, targetPosition: 'Backend Intern' },
  });
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, pipelineStatus: 'INTERVIEW_PENDING_250' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    // Click through from the list into the candidate detail page.
    await page.getByText('Detail Candidate').click();
    await page.waitForURL(`**/company/candidates/${mentee.id}`);
    await expect(page.getByRole('heading', { name: 'Detail Candidate' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('TU Berlin')).toBeVisible();
    await expect(page.getByText('React · 4/5')).toBeVisible();
    await expect(page.getByText('Backend Intern')).toBeVisible();

    // IDOR check: a candidate not linked to this company is not accessible.
    const res = await page.request.get(`/api/company/candidates/${outsider.id}`);
    expect(res.status()).toBe(404);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(outsiderEmail);
    await prisma.user.deleteMany({ where: { id: companyUser.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
  }
});
