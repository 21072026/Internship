import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password = 'Pass1234!') {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
}

// #1210: the zone picker used to live only on the mentee profile form, so an
// admin or mentor whose zone was guessed from a VPN'd browser had no way to
// correct it — and every meeting time they were emailed stayed on that clock.
test.describe('everyone can set their own timezone', () => {
  // Deliberately NOT the zone the test picks: the point is that the saved value
  // beats whatever the browser reports.
  test.use({ timezoneId: 'Europe/Berlin' });

  test('a mentor saves a zone from /account and it survives a reload', async ({ page }) => {
    const email = uniqueEmail('tz-settings-mentor');
    await seedUser(email, 'Pass1234!', 'MENTOR', 'TZ Settings Mentor');

    try {
      await signIn(page, email);
      await page.goto('/account');

      const select = page.getByTestId('timezone-select');
      await expect(select).toBeVisible();
      await select.selectOption('Asia/Tokyo');

      // Saved on pick — no submit button to forget.
      await expect(page.getByTestId('timezone-current')).toContainText(/GMT\+9/, { timeout: 10_000 });
      await expect.poll(async () => (await prisma.user.findUnique({ where: { email } }))?.timezone).toBe('Asia/Tokyo');

      await page.reload();
      await expect(page.getByTestId('timezone-select')).toHaveValue('Asia/Tokyo');

      // The browser is in Berlin, so the app offers that zone — as an offer, not
      // an overwrite: the deliberate choice above is still what is stored.
      await expect(page.getByTestId('timezone-detected')).toContainText('Europe/Berlin');
    } finally {
      await cleanupByEmail(email);
    }
  });

  test('registration records the browser zone', async ({ page }) => {
    const email = uniqueEmail('tz-register');

    try {
      await page.goto('/auth/register');
      await page.fill('input[name="fullName"]', 'TZ Register');
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', 'Pass1234!');
      await page.fill('input[name="confirmPassword"]', 'Pass1234!');
      await page.check('input[name="consent"]');
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

      await expect
        .poll(async () => (await prisma.user.findUnique({ where: { email } }))?.timezone, { timeout: 20_000 })
        .toBe('Europe/Berlin');
    } finally {
      await cleanupByEmail(email);
    }
  });
});

// The confirmation the organizer never had: what the time they just picked reads
// as on the clock of every person they are about to invite.
test.describe('scheduling shows the time on every attendee’s clock', () => {
  test.use({ timezoneId: 'Europe/Berlin' });

  test('a mentee in another zone gets their own line', async ({ page }) => {
    const mentorEmail = uniqueEmail('tz-preview-mentor');
    const menteeEmail = uniqueEmail('tz-preview-mentee');
    const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Preview Mentor');
    const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Preview Mentee');
    // Istanbul is GMT+3 against Berlin's GMT+2 in August — one hour apart, so a
    // wrong reading is visible rather than plausible.
    await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'Europe/Istanbul' } });
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
    });

    try {
      await signIn(page, mentorEmail);
      await page.goto('/mentor/meetings');
      await page.getByRole('checkbox').first().check();
      await page.getByLabel('Date', { exact: true }).fill('2026-08-03');
      await page.getByLabel('Time', { exact: true }).fill('16:30');

      const block = page.getByTestId('attendee-times');
      await expect(block).toBeVisible();
      // The organizer's own clock (Berlin, GMT+2) and the mentee's (GMT+3).
      await expect(block).toContainText('16:30');
      await expect(block).toContainText('17:30');
      await expect(block).toContainText('Preview Mentee');
    } finally {
      await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(menteeEmail);
    }
  });
});
