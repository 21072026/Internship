import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// The onboarding cards on the mentor dashboard are compact: each one collapses
// to name + x/y progress + the next step, and that choice survives a reload.
test('the mentee onboarding card collapses to a one-line summary', async ({ page }) => {
  const mentorEmail = uniqueEmail('onbcollapse-mentor');
  const menteeEmail = uniqueEmail('onbcollapse-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Collapse Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Collapse Mentee');
  // Fresh relation on the first pipeline stage → the onboarding card volunteers itself.
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    const card = page.getByTestId(`onboarding-card-${mentee.id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Nothing has happened yet, so no step is ticked.
    await expect(page.getByTestId(`onboarding-progress-${mentee.id}`)).toHaveText('0/6');
    await expect(card.getByTestId('onboarding-step-welcomeMessage')).toBeVisible();

    // Collapsed: the checklist goes away, the summary line takes over.
    await page.getByTestId(`onboarding-toggle-${mentee.id}`).click();
    await expect(card.getByTestId('onboarding-step-welcomeMessage')).toBeHidden();
    await expect(page.getByTestId(`onboarding-next-${mentee.id}`)).toBeVisible();
    // The name stays reachable while collapsed.
    await expect(page.getByTestId(`onboarding-mentee-link-${mentee.id}`)).toHaveAttribute(
      'href',
      `/mentor/mentees/${rel.id}`
    );

    // Remembered across reloads.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('onboarding-step-welcomeMessage')).toBeHidden();

    // ...and re-openable.
    await page.getByTestId(`onboarding-toggle-${mentee.id}`).click();
    await expect(card.getByTestId('onboarding-step-welcomeMessage')).toBeVisible();
  } finally {
    await prisma.menteeOnboarding.deleteMany({ where: { mentorId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
