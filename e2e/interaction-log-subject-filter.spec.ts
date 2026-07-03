import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Betül feedback B7/B8: interaction logs carry an optional subject, and the
// mentor's aggregate list can be filtered by type and searched.
test('interaction logs carry a subject and the aggregate list can be filtered/searched', async ({ page }) => {
  const mentorEmail = uniqueEmail('ils-mentor');
  const menteeAEmail = uniqueEmail('ils-mentee-a');
  const menteeBEmail = uniqueEmail('ils-mentee-b');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ILS Mentor');
  const menteeA = await seedUser(menteeAEmail, 'x', 'MENTEE', 'ILS Mentee Alpha');
  const menteeB = await seedUser(menteeBEmail, 'x', 'MENTEE', 'ILS Mentee Beta');
  const relA = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeA.id } });
  const relB = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeB.id } });
  const uniqueSubject = `Onboarding checklist ${Date.now().toString(36)}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Log an interaction with a subject for mentee A.
    await page.goto(`/mentor/mentees/${relA.id}`);
    await page.getByRole('button', { name: 'Add Log' }).click();
    const form = page.getByTestId('interaction-log-form');
    await form.getByTestId('interaction-log-date').fill('2026-01-15');
    await form.getByTestId('interaction-log-subject').fill(uniqueSubject);
    await form.getByTestId('interaction-log-notes').fill('Went through the first-week checklist together');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(uniqueSubject)).toBeVisible({ timeout: 10_000 });

    // A plain Feedback-type interaction for mentee B, no subject, so the type
    // filter and search have something to distinguish.
    await prisma.interactionLog.create({
      data: { relationId: relB.id, date: new Date('2026-01-10'), type: 'Feedback', notes: 'Quarterly check-in' },
    });

    await page.goto('/mentor/interactions');
    await expect(page.getByText(uniqueSubject)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Quarterly check-in')).toBeVisible();

    // Type filter narrows to Feedback only.
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await expect(page.getByText('Quarterly check-in')).toBeVisible();
    await expect(page.getByText(uniqueSubject)).toHaveCount(0);

    // Back to all, then search by the unique subject text.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByPlaceholder(/search subject/i).fill(uniqueSubject);
    await expect(page.getByText(uniqueSubject)).toBeVisible();
    await expect(page.getByText('Quarterly check-in')).toHaveCount(0);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: { in: [relA.id, relB.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relA.id, relB.id] } } });
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await cleanupByEmail(mentorEmail);
  }
});
