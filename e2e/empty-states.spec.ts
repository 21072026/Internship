import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Role-aware empty states (#2077). A brand-new tenant's screens must say what
// to do next, and the "what" depends on who is looking — so the two assertions
// that matter are: the mentee is offered the one route they may actually use,
// and the mentor is offered nothing at all (assigning a mentorship is an admin
// action; a button here would walk straight into a 403).
//
// Both users are freshly seeded with no relations of their own, so neither
// screen depends on the rest of the suite's rows — unlike the admin board,
// which lists every mentorship in the database.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an unassigned mentor sees an explanation and no action', async ({ page }) => {
  const email = uniqueEmail('esmentor');
  await seedUser(email, 'MentorPass123!', 'MENTOR', 'Empty State Mentor');

  try {
    await signInAndSettle(page, email, 'MentorPass123!', '/mentor');
    await gotoSettled(page, '/mentor/board');

    const empty = page.getByTestId('empty-mentor-board');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('once an admin assigns them');
    // The role-aware contract: no entry in `byRole` means no rendered action.
    await expect(empty.locator('a, button')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('a mentee without a mentor is pointed at the one route they may use', async ({ page }) => {
  const email = uniqueEmail('esmentee');
  await seedUser(email, 'MenteePass123!', 'MENTEE', 'Empty State Mentee');

  try {
    await signInAndSettle(page, email, 'MenteePass123!', '/portal');
    await gotoSettled(page, '/portal/goals');

    const empty = page.getByTestId('empty-portal-goals');
    await expect(empty).toBeVisible();
    const cta = empty.getByRole('link');
    await expect(cta).toHaveAttribute('href', '/portal/profile');

    // Dark mode: globals.css retints these utilities with flat `html.dark`
    // rules that outrank any `dark:` variant, so assert the computed colors
    // rather than trusting the class list (CLAUDE.md, dark-mode section).
    // Start from a known light baseline so the runner's OS preference can't
    // decide the outcome.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    const title = empty.locator('p').first();
    const icon = empty.locator('div').first();
    const color = (el: Element) => getComputedStyle(el).color;
    const background = (el: Element) => getComputedStyle(el).backgroundColor;
    const channels = (value: string) => value.match(/\d+(\.\d+)?/g)!.map(Number);

    // Light: dark title on a light icon chip.
    expect(Math.max(...channels(await title.evaluate(color)))).toBeLessThan(90);
    expect(Math.min(...channels(await icon.evaluate(background)))).toBeGreaterThan(200);

    await page.evaluate(() => document.documentElement.classList.add('dark'));

    // Dark: text-gray-900 must become near-white and the bg-gray-100 chip must
    // retint — a light chip here would be the dark-on-dark failure mode.
    expect(Math.min(...channels(await title.evaluate(color)))).toBeGreaterThan(180);
    expect(Math.max(...channels(await icon.evaluate(background)))).toBeLessThan(120);
  } finally {
    await cleanupByEmail(email);
  }
});
