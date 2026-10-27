import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, submitSignInForm } from './helpers/auth';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

// Calendar export + print (#2005). "Download .ics" builds the file in the
// browser from the events on screen through the one feed builder
// (buildFeedIcs, src/lib/ics.ts) — so the file must be a VCALENDAR carrying the
// meeting under the subscription feed's own UID. Print hides the toolbar, the
// view switcher and the legend but keeps the date heading.
test.describe('calendar export and print', () => {
  const mentorEmail = uniqueEmail('cal-export-mentor');
  const menteeEmail = uniqueEmail('cal-export-mentee');
  let meetingId = '';
  const title = `Export check ${Date.now()}`;

  test.beforeAll(async () => {
    const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Export Mentor');
    const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Export Mentee');
    const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
    // Today, an hour from now (or earlier today near midnight) — the day view.
    const now = new Date();
    const when = new Date(now.getTime() + 60 * 60 * 1000);
    if (when.getDate() !== now.getDate()) when.setTime(now.getTime() - 60 * 60 * 1000);
    const meeting = await prisma.meeting.create({
      data: {
        relationId: relation.id,
        title,
        scheduledAt: when,
        durationMinutes: 45,
        createdById: mentor.id,
        rsvpToken: `export-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    meetingId = meeting.id;
  });

  test.afterAll(async () => {
    await prisma.meeting.deleteMany({ where: { id: meetingId } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.$disconnect();
  });

  test('downloads the range on screen as a valid .ics, and prints without chrome', async ({ page }) => {
    await submitSignInForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.waitForURL((u) => !u.pathname.startsWith('/auth/signin'), { timeout: 30_000 });
    await gotoSettled(page, '/admin/calendar');
    await page.getByTestId('calendar-view-day').click();
    await expect(page.getByTestId(`calendar-event-meeting-${meetingId}`)).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('calendar-download-ics').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.ics$/);
    const ics = await readFile((await download.path())!, 'utf8');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('METHOD:PUBLISH');
    // The feed's UID — the bare meeting id, not the calendar's `meeting-` key.
    expect(ics).toContain(`UID:${meetingId}@crm.ersah.in`);
    expect(ics).toContain(`SUMMARY:Export Mentee · ${title}`);
    // The stored 45 minutes, not the default length.
    const block = ics.slice(ics.indexOf(`UID:${meetingId}`));
    const start = /DTSTART:(\d{8}T\d{6})Z/.exec(block)![1];
    const end = /DTEND:(\d{8}T\d{6})Z/.exec(block)![1];
    const parse = (s: string) =>
      Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    expect((parse(end) - parse(start)) / 60_000).toBe(45);

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('calendar-view-switcher')).toBeHidden();
    await expect(page.getByTestId('calendar-download-ics')).toBeHidden();
    await expect(page.getByTestId('ics-feed-card')).toBeHidden();
    await expect(page.locator('#calendar-print h2')).toBeVisible();
    await expect(page.getByTestId(`calendar-event-meeting-${meetingId}`)).toBeVisible();
  });
});
