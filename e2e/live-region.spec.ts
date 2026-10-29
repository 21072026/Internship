import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';

/**
 * WCAG 4.1.3 (Status Messages), #2047.
 *
 * The failure this guards against is subtle enough that it survives every axe
 * scan: a status message is only spoken when its container was ALREADY in the
 * accessibility tree before the text arrived. So the two assertions below are,
 * in order:
 *
 *   1. the polite live region is in the DOM and EMPTY on load — mounted ahead of
 *      any message, which is what makes the announcement work at all;
 *   2. it receives the text after a filter changes the page without moving
 *      focus (the admin board's search box).
 *
 * Not `@smoke`: it is a regression net for the a11y plumbing, not a critical
 * path the PR gate has to re-prove on every push.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the app-wide live region is mounted empty and receives the filter result count', async ({ page }) => {
  const nonce = Date.now().toString(36);
  const adminEmail = uniqueEmail('lr-admin');
  const mentorEmail = uniqueEmail('lr-mentor');
  const menteeEmail = uniqueEmail('lr-mentee');
  const pw = 'LiveRegion123!';
  // A name no other spec's seed data can collide with: the admin board lists
  // every relation in the database, so the announced count is only predictable
  // if exactly one row can match the query.
  const menteeName = `Zeliha Canlibolge ${nonce}`;
  await seedUser(adminEmail, pw, 'ADMIN', 'Live Region Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Live Region Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', menteeName);
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    // English, so the assertions can name the exact strings.
    await page.goto('/auth/signin');
    await page.evaluate(() => { document.cookie = 'locale=en;path=/'; });
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const region = page.getByTestId('live-region-polite');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveAttribute('aria-atomic', 'true');
    // Present, and silent until something happens.
    await expect(region).toHaveText('');

    await page.goto('/admin/board');
    await expect(page.getByText(menteeName)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('board-search').fill(nonce);
    // The announcement is debounced (useFilterAnnouncement), so poll rather than
    // asserting on the next tick.
    await expect
      .poll(async () => (await region.textContent())?.trim(), { timeout: 10_000 })
      .toBe('1 result shown');

    await page.getByTestId('board-search').fill(`${nonce}-nobody-matches-this`);
    await expect
      .poll(async () => (await region.textContent())?.trim(), { timeout: 10_000 })
      .toBe('No results');
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({
      where: { actorEmail: { in: [adminEmail, mentorEmail, menteeEmail] } },
    });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #2864: every list with a search box speaks its result count through the same
// hook (`check:` in the VPAT's 4.1.3 row keeps it that way). Two of its shapes:
// a server-paginated list (/admin/users, the count is the API's total) and a
// client-side filter (the admin sidebar's own nav filter).
test('server-side and client-side list filters announce their result count', async ({ page }) => {
  const nonce = Date.now().toString(36);
  const adminEmail = uniqueEmail('lr-lists');
  const pw = 'LiveRegion123!';
  await seedUser(adminEmail, pw, 'ADMIN', `Live Region Lists ${nonce}`);
  try {
    await page.goto('/auth/signin');
    await page.evaluate(() => { document.cookie = 'locale=en;path=/'; });
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    const region = page.getByTestId('live-region-polite');

    await gotoSettled(page, '/admin/users');
    // The list has loaded (and the page hydrated) once a row's action shows —
    // the name alone also matches the account menu in the sidebar.
    await expect(page.getByRole('button', { name: 'Deactivate' }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('users-search').fill(nonce);
    await expect
      .poll(async () => (await region.textContent())?.trim(), { timeout: 10_000 })
      .toBe('1 result shown');
    await page.getByTestId('users-search').fill(`${nonce}-nobody-matches-this`);
    await expect
      .poll(async () => (await region.textContent())?.trim(), { timeout: 10_000 })
      .toBe('No results');

    // The sidebar filter is on every admin page; nothing in it matches this.
    await page.getByRole('searchbox', { name: /Filter menu/ }).fill('zzzz-no-such-page');
    await expect
      .poll(async () => (await region.textContent())?.trim(), { timeout: 10_000 })
      .toBe('No results');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
