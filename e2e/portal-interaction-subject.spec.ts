import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The mentor types a subject on every interaction log and the mentee never saw
 * it (#1421): `/portal/interactions` declared no `subject` on its row type and
 * `/portal/journey` rendered the note only. Both screens now lead with the
 * subject when there is one, and are unchanged when there is not.
 */
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee sees the subject the mentor wrote on an interaction', async ({ page }) => {
  const mentorEmail = uniqueEmail('isub-mentor');
  const menteeEmail = uniqueEmail('isub-mentee');
  const subject = `Sprint review ${Date.now()}`;
  const titledNote = 'We walked through the demo and the open bugs.';
  const untitledNote = `Quick check-in with no subject ${Date.now()}`;

  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ISub Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'ISub Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  await prisma.interactionLog.createMany({
    data: [
      { relationId: rel.id, date: new Date(), subject, notes: titledNote, type: 'Meeting' },
      { relationId: rel.id, date: new Date(Date.now() - 86_400_000), notes: untitledNote, type: 'Email' },
    ],
  });

  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');

    // 1. The interactions list shows the subject above the note, in the same
    //    bold treatment the mentor's own screens give it.
    await page.goto('/portal/interactions');
    const subjectLine = page.getByTestId('interaction-subject').filter({ hasText: subject });
    await expect(subjectLine).toBeVisible({ timeout: 10_000 });
    expect(await subjectLine.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('500');
    await expect(page.getByText(titledNote, { exact: true })).toBeVisible();

    // 2. A log with no subject is unchanged: its note is there and it grew no
    //    subject line of its own (only the titled log has one).
    await expect(page.getByText(untitledNote, { exact: true })).toBeVisible();
    await expect(page.getByTestId('interaction-subject')).toHaveCount(1);

    // 3. The journey page's narrow "recent interactions" list leads with the
    //    subject too, and stays inside a 375px viewport.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/portal/journey');
    await expect(page.getByTestId('journey-interaction-subject').filter({ hasText: subject }))
      .toBeVisible({ timeout: 10_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
