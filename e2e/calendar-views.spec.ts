import { test, expect, type Route } from '@playwright/test';
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

const eventInside = (route: Route, id: string, title: string) => {
  const from = new Date(new URL(route.request().url()).searchParams.get('from')!);
  from.setDate(from.getDate() + 2);
  return { id, type: 'meeting', title, who: 'Calendar Mentee', date: from.toISOString() };
};

test('calendar separates loading, empty and error states and retries the visible month', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('cal-loading');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Calendar Loading Mentor');
  const pending: Route[] = [];

  try {
    await signInAndSettle(page, email, 'MentorPass123', '/mentor');
    await page.route('**/api/calendar-events?**', async (route) => { pending.push(route); });
    await page.goto('/mentor/calendar');

    await expect.poll(() => pending.length).toBe(1);
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByTestId('calendar-empty')).toHaveCount(0);
    await pending[0].fulfill({ json: { events: [eventInside(pending[0], 'slow-event', 'Loaded event')] } });
    await expect(page.getByTitle('Loaded event · Calendar Mentee')).toBeVisible();
    await expect(page.getByTestId('calendar-empty')).toHaveCount(0);

    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect.poll(() => pending.length).toBe(2);
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByTestId('calendar-empty')).toHaveCount(0);
    await pending[1].fulfill({ json: { events: [] } });
    await expect(page.getByTestId('calendar-empty')).toBeVisible();

    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect.poll(() => pending.length).toBe(3);
    await pending[2].fulfill({ status: 500, json: { error: 'Failed' } });
    await expect(page.getByTestId('calendar-load-error')).toContainText('Calendar events could not be loaded');
    await expect(page.getByTestId('calendar-empty')).toHaveCount(0);

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => pending.length).toBe(4);
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await pending[3].fulfill({ json: { events: [eventInside(pending[3], 'retry-event', 'Retry event')] } });
    await expect(page.getByTitle('Retry event · Calendar Mentee')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('a slower old-month response cannot overwrite the current month', async ({ page }) => {
  const email = uniqueEmail('cal-race');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Calendar Race Mentor');
  let requestCount = 0;

  try {
    await signInAndSettle(page, email, 'MentorPass123', '/mentor');
    await page.route('**/api/calendar-events?**', async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.fulfill({ json: { events: [] } });
        return;
      }
      const oldRequest = requestCount === 2;
      await new Promise((resolve) => setTimeout(resolve, oldRequest ? 300 : 20));
      await route.fulfill({
        json: { events: [eventInside(route, oldRequest ? 'stale-event' : 'current-event', oldRequest ? 'Stale event' : 'Current event')] },
      });
    });
    await page.goto('/mentor/calendar');
    await expect(page.getByTestId('calendar-empty')).toBeVisible();

    await page.getByRole('button', { name: 'next', exact: true }).click();
    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect(page.getByTitle('Current event · Calendar Mentee')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.getByTitle('Current event · Calendar Mentee')).toBeVisible();
    await expect(page.getByTitle('Stale event · Calendar Mentee')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});
