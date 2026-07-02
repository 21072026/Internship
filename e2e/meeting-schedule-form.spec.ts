import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #443 (B6/B9): the meeting form uses separate Date + Time fields (so entering
// a time doesn't pop a calendar) and preset topic suggestions. Scheduling with
// the split fields still creates the meeting.
test('mentor schedules a meeting via separate date and time fields', async ({ page }) => {
  const mentorEmail = uniqueEmail('mtg-mentor');
  const menteeEmail = uniqueEmail('mtg-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Mtg Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Mtg Mentee');
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'Pass1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/mentor/meetings');
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Title').fill('Weekly check-in');
    await page.getByLabel('Date', { exact: true }).fill('2026-08-01');
    await page.getByLabel('Time', { exact: true }).fill('14:30');
    await page.getByRole('button', { name: /send invite/i }).click();

    // Confirmation banner shows the meeting was created for 1 mentee.
    await expect(page.getByText(/invite sent to 1/i)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
