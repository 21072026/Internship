import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor emails a mentee and it is logged as an interaction', async ({ page }) => {
  const mentorEmail = uniqueEmail('mailmentor');
  const menteeEmail = uniqueEmail('mailmentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Mailing Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Mailed Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/email');
    await page.getByText('Select all').click();
    await page.getByLabel('Subject').fill('Weekly check-in');
    await page.getByLabel('Message').fill('Hi, let us sync this week.');
    const sent = page.waitForResponse(
      (r) => r.url().includes('/api/mentor/email') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Send email' }).click();
    await sent;
    await expect(page.getByText(/Email sent to 1/)).toBeVisible({ timeout: 10_000 });

    const logs = await prisma.interactionLog.findMany({ where: { relationId: rel.id, type: 'Email' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].notes).toContain('Weekly check-in');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
