import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a company can shortlist a linked candidate; the mentor is notified and sees the signal', async ({ page }) => {
  const companyEmail = uniqueEmail('co-shortlist');
  const mentorEmail = uniqueEmail('co-shortlist-mentor');
  const menteeEmail = uniqueEmail('co-shortlist-mentee');
  const outsiderEmail = uniqueEmail('co-shortlist-outsider');
  const pw = 'CompanyPass123!';

  const org = await prisma.organization.create({ data: { name: `Shortlist Org ${Date.now()}`, slug: `shortlist-${Date.now()}` } });
  const company = await prisma.company.create({ data: { name: `Shortlist Co ${Date.now()}`, orgId: org.id } });
  const companyUser = await prisma.user.create({
    data: {
      email: companyEmail,
      password: await bcrypt.hash(pw, 10),
      role: 'COMPANY',
      fullName: 'Shortlist Co Observer',
      companyId: company.id,
      orgId: org.id,
      skills: [],
    },
  });
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Shortlist Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Shortlist Candidate');
  const outsider = await seedUser(outsiderEmail, 'x', 'MENTEE', 'Shortlist Outsider');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id },
  });

  try {
    // Company sets a shortlist with a note.
    await signInAndSettle(page, companyEmail, pw, '/company');

    await gotoSettled(page, `/company/candidates/${mentee.id}`);
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

    const notes = await prisma.notification.findMany({ where: { userId: mentor.id, type: 'company_interest.shortlisted' } });
    expect(notes.length).toBe(1);
    const params = notes[0].params as { company?: string; mentee?: string };
    expect(params?.mentee).toBe('Shortlist Candidate');
    expect(params?.company).toContain('Shortlist Co');

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
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
