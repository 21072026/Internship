import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// The calendar is no longer month-only (#1110): week, day and an "upcoming"
// agenda share the same data, and the agenda is what a phone gets by default.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the calendar switches between month, week, day and upcoming views', async ({ page }) => {
  const mentorEmail = uniqueEmail('cal-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Cal Mentor');
  const mentee = await seedUser(uniqueEmail('cal-mentee'), 'x', 'MENTEE', 'Cal Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  // Tomorrow at midday — inside every one of the four windows.
  const when = new Date(Date.now() + 24 * 60 * 60 * 1000);
  when.setHours(12, 0, 0, 0);
  await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Kickoff Call',
      scheduledAt: when,
      rsvpToken: randomBytes(12).toString('hex'),
      createdById: mentor.id,
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/calendar');

    await page.getByTestId('calendar-view-month').click();
    await expect(page.getByTestId('calendar-month-grid')).toBeVisible();

    await page.getByTestId('calendar-view-week').click();
    await expect(page.getByTestId('calendar-week')).toBeVisible();

    await page.getByTestId('calendar-view-day').click();
    await expect(page.getByTestId('calendar-day')).toBeVisible();

    // The agenda lists what is coming up, tomorrow's meeting included.
    await page.getByTestId('calendar-view-agenda').click();
    const agenda = page.getByTestId('calendar-agenda');
    await expect(agenda).toBeVisible();
    await expect(agenda.getByText('Cal Mentee', { exact: true })).toBeVisible();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('a phone opens the calendar on the upcoming list, not the month grid', async ({ page }) => {
  const email = uniqueEmail('cal-mobile');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Cal Mobile Mentor');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndSettle(page, email, 'MentorPass123', '/mentor');
    await page.goto('/mentor/calendar');

    await expect(page.getByTestId('calendar-agenda')).toBeVisible();
    await expect(page.getByTestId('calendar-month-grid')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});
