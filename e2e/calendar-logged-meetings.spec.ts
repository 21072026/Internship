import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC D (#417): the admin calendar was empty even though the team logged
// meetings — because logged "Meeting" interactions (InteractionLog) are a
// different model from scheduled Meetings, and only the latter fed the calendar.
// Logged meetings must now surface as calendar events.
test('a logged "Meeting" interaction shows up on the admin calendar', async ({ page }) => {
  const mentorEmail = uniqueEmail('cal-mentor');
  const menteeEmail = uniqueEmail('cal-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Cal Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Cal Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  // A meeting logged as an interaction, dated today so it lands in the default month.
  const log = await prisma.interactionLog.create({
    data: { relationId: relation.id, type: 'Meeting', notes: 'Kickoff call', date: new Date() },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // The calendar-events feed includes the logged meeting as a 'logged' event.
    const feed = await (await page.request.get('/api/calendar-events')).json();
    const ev = feed.events.find((e: { id: string }) => e.id === `logged-${log.id}`);
    expect(ev).toBeTruthy();
    expect(ev.type).toBe('logged');
    expect(ev.who).toBe('Cal Mentee');

    // And it renders on the calendar page (mentee name shown in the grid cell).
    await page.goto('/admin/calendar');
    await expect(page.getByText('Cal Mentee', { exact: true }).first()).toBeVisible();
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
