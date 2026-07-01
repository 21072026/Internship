import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a company can shortlist a linked candidate; the mentor is notified and sees the signal', async ({ page }) => {
  const companyEmail = uniqueEmail('co-shortlist');
  const mentorEmail = uniqueEmail('co-shortlist-mentor');
  const menteeEmail = uniqueEmail('co-shortlist-mentee');
  const outsiderEmail = uniqueEmail('co-shortlist-outsider');
  const pw = 'CompanyPass123!';

  const company = await prisma.company.create({ data: { name: `Shortlist Co ${Date.now()}` } });
  const companyUser = await prisma.user.create({
    data: {
      email: companyEmail,
      password: await bcrypt.hash(pw, 10),
      role: 'COMPANY',
      fullName: 'Shortlist Co Observer',
      companyId: company.id,
      skills: [],
    },
  });
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Shortlist Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Shortlist Candidate');
  const outsider = await seedUser(outsiderEmail, 'x', 'MENTEE', 'Shortlist Outsider');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
  });

  try {
    // Company sets a shortlist with a note.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    await page.goto(`/company/candidates/${mentee.id}`);
    await page.fill('textarea', 'Great fit for backend team.');
    await page.getByRole('button', { name: /Shortlisted/i }).click();
    await expect(page.getByText(/mentor has been notified/i)).toBeVisible({ timeout: 10_000 });

    // IDOR: cannot set interest on an unlinked candidate.
    const idor = await page.request.post('/api/company/interests', {
      data: { menteeId: outsider.id, status: 'INTERESTED' },
    });
    expect(idor.status()).toBe(404);

    await page.context().clearCookies();

    // Mentor sees the notification and the signal on the mentee detail page.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const notes = await prisma.notification.findMany({ where: { userId: mentor.id, type: 'company_interest' } });
    expect(notes.length).toBe(1);
    expect(notes[0].text).toContain('Shortlist Candidate');

    await page.goto(`/mentor/mentees/${rel.id}`);
    await expect(page.getByText(/Shortlisted by company/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Great fit for backend team.')).toBeVisible();
  } finally {
    await prisma.companyInterest.deleteMany({ where: { companyId: company.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(outsiderEmail);
    await prisma.user.deleteMany({ where: { id: companyUser.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
  }
});
