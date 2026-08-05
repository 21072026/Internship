import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A mentee's name on the mentor dashboard is a link to their mentorship page —
// in the onboarding card and in the "my mentees" list alike.
test('mentee names on the mentor dashboard link to the mentorship page', async ({ page }) => {
  const mentorEmail = uniqueEmail('namelink-mentor');
  const menteeEmail = uniqueEmail('namelink-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'NameLink Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'NameLink Mentee');
  // Fresh relation on the first pipeline stage → the onboarding card volunteers itself.
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    const nameLink = page.getByTestId(`onboarding-mentee-link-${mentee.id}`);
    await expect(nameLink).toBeVisible({ timeout: 15_000 });
    await expect(nameLink).toHaveAttribute('href', `/mentor/mentees/${rel.id}`);

    // The same name in the mentee list is a link too.
    await expect(
      page.getByRole('link', { name: 'NameLink Mentee', exact: true }).first()
    ).toHaveAttribute('href', `/mentor/mentees/${rel.id}`);

    // Clicking it lands on the mentorship page.
    await nameLink.click();
    await page.waitForURL(`**/mentor/mentees/${rel.id}`, { timeout: 20_000 });
  } finally {
    await prisma.menteeOnboarding.deleteMany({ where: { mentorId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
