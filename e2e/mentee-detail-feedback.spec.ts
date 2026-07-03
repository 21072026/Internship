import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Betül feedback B4/B5: success toasts after mutations, and an example card
// instead of a bare "no interactions" message when the log is empty.
test('mentee detail: empty interaction log shows an example card, and logging one shows a success toast', async ({ page }) => {
  const mentorEmail = uniqueEmail('mdf-mentor');
  const menteeEmail = uniqueEmail('mdf-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MDF Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'MDF Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto(`/mentor/mentees/${rel.id}`);
    await expect(page.getByText('No interactions logged yet')).toBeVisible({ timeout: 10_000 });
    // The illustrative example card is shown alongside the empty message.
    await expect(page.getByText('Example')).toBeVisible();

    await page.getByRole('button', { name: 'Add Log' }).click();
    const form = page.getByTestId('interaction-log-form');
    await form.getByTestId('interaction-log-date').fill('2026-01-15');
    await form.getByTestId('interaction-log-notes').fill('Discussed onboarding checklist');
    await form.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Interaction logged' })).toBeVisible({ timeout: 10_000 });
    // The example card is gone now that a real interaction exists.
    await expect(page.getByText('Example')).toHaveCount(0);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
