import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Two findings from the manual AT review (#2047 → #2153) that axe cannot see:
// month-grid cells were announced as a bare "17", and the view switcher claimed
// the tab pattern without behaving like one.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a month cell is named by its full date and its events, toggles with aria-pressed, and the switcher is a button group', async ({ page }) => {
  const mentorEmail = uniqueEmail('cal-a11y-mentor');
  const menteeEmail = uniqueEmail('cal-a11y-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Cal A11y Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Cal A11y Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  // The 10th of next month at midday: never today, always inside that month.
  const now = new Date();
  const when = new Date(now.getFullYear(), now.getMonth() + 1, 10, 12, 0, 0);
  const title = `A11y Kickoff ${randomBytes(3).toString('hex')}`;
  await prisma.meeting.create({
    data: { relationId: rel.id, title, scheduledAt: when, rsvpToken: randomBytes(12).toString('hex'), createdById: mentor.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/calendar');
    await page.getByTestId('calendar-view-month').click();

    // The switcher: a labelled group of toggle buttons, and nothing claiming to be a tab.
    const switcher = page.getByRole('group', { name: 'Calendar view' });
    await expect(switcher.getByRole('button')).toHaveCount(4);
    await expect(page.getByTestId('calendar-view-month')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('calendar-view-week')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);

    // Forward one month (the meeting's month) and find its cell BY NAME.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const fullDate = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(when);
    // The chip on a mentor's calendar names the counterpart, so that is the
    // event text the cell's name must still carry after the date.
    const cell = page.getByRole('button', { name: new RegExp(`^${fullDate}.*Cal A11y Mentee`) });
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveAttribute('aria-pressed', 'false');
    await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('calendar-selected-day')).toBeVisible();

    // The visible number is aria-hidden now. contrast-1417 still measures it:
    // axe's colour-contrast rule reports the nodes it evaluated, and they must
    // be among them (passing), not silently out of scope.
    const axe = await new AxeBuilder({ page }).include('[data-testid="calendar-day-number"]').withRules(['color-contrast']).analyze();
    const measured = [...axe.passes, ...axe.violations, ...axe.incomplete].flatMap((r) => r.nodes);
    expect(measured.length).toBeGreaterThanOrEqual(28);
    expect(axe.violations).toEqual([]);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.delete({ where: { id: rel.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
