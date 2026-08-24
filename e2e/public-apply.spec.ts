import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('public application form creates a mentee linked to the mentor', async ({ page }) => {
  const mentorEmail = uniqueEmail('applymentor');
  const applicantEmail = uniqueEmail('applicant');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Apply Mentor');

  try {
    // No auth — this is a public page.
    await page.goto(`/apply/${mentor.id}`);
    await expect(page.getByRole('heading', { name: 'Apply for mentorship' })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel('Full name').fill('Walk In Applicant');
    await page.getByLabel(/^Email/).fill(applicantEmail);
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith('/api/apply') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Submit application' }).click();
    await submitted;
    await expect(page.getByText('Application received')).toBeVisible({ timeout: 10_000 });

    // A mentee account was created and a PENDING application awaits the
    // mentor's accept/decline (#1188) — no instant relation any more.
    const mentee = await prisma.user.findUnique({ where: { email: applicantEmail } });
    expect(mentee?.role).toBe('MENTEE');
    const request = await prisma.mentorshipRequest.findFirst({
      where: { preferredMentorId: mentor.id, menteeId: mentee!.id },
    });
    expect(request?.status).toBe('PENDING');
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee!.id },
    });
    expect(rel).toBeNull();
  } finally {
    await cleanupByEmail(applicantEmail);
    await cleanupByEmail(mentorEmail);
  }
});
