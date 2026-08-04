import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1061: the Date + Time inputs produce a bare wall clock ("2026-08-03T16:30")
// with no zone. That used to be POSTed as-is and read with `new Date()` on a
// server running UTC, so an organizer in Germany who picked 16:30 got a meeting
// stored at 16:30Z — 18:30 on their own clock, which is what the reminder email
// then told them. The picked wall clock must survive the round trip whatever
// zone the browser is in, so this asserts the stored instant, not the rendering.
test.describe('meeting times are stored in the organizer’s zone', () => {
  // CEST in August, so 16:30 local is 14:30Z. A zone with a non-zero offset is
  // the whole point — under UTC the bug is invisible.
  test.use({ timezoneId: 'Europe/Berlin' });

  test('16:30 picked in Europe/Berlin is stored as 14:30Z, not 16:30Z', async ({ page }) => {
    const mentorEmail = uniqueEmail('tz-mentor');
    const menteeEmail = uniqueEmail('tz-mentee');
    const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'TZ Mentor');
    const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'TZ Mentee');
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
    });

    try {
      await page.goto('/auth/signin');
      await page.fill('input[type="email"], input[name="email"]', mentorEmail);
      await page.fill('input[type="password"]', 'Pass1234!');
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

      await page.goto('/mentor/meetings');
      await page.getByRole('checkbox').first().check();
      await page.getByLabel('Title').fill('Timezone check-in');
      await page.getByLabel('Date', { exact: true }).fill('2026-08-03');
      await page.getByLabel('Time', { exact: true }).fill('16:30');
      await page.getByRole('button', { name: /send invite/i }).click();
      await expect(page.getByText(/invite sent to 1/i)).toBeVisible({ timeout: 10_000 });

      const meeting = await prisma.meeting.findFirst({
        where: { relationId: relation.id, title: 'Timezone check-in' },
      });
      expect(meeting?.scheduledAt?.toISOString()).toBe('2026-08-03T14:30:00.000Z');

      // …and the mentor reads back the clock time they picked. The list renders
      // via Intl in the browser's locale, so accept either 24h or 12h form.
      await expect(page.getByText(/(16:30|4:30\s*PM)/i).first()).toBeVisible();
    } finally {
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(menteeEmail);
    }
  });
});
