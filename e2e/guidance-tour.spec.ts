import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from '../src/lib/cookieConsent';

/**
 * In-app tours and contextual help (#2067). The suite's storage state turns
 * the automatic offer off (e2e/global-setup.ts); this spec starts from a
 * browser that has only accepted cookies — a real first visit.
 *
 *   * a new admin is offered the first-run tour, completes it with the
 *     keyboard alone, and is never offered it again — not even from a wiped
 *     browser, because the record is on the server;
 *   * Escape skips (and records the skip) for a new mentor;
 *   * the coachmark is an accessible modal dialog and has no motion under
 *     prefers-reduced-motion;
 *   * /api/guidance only ever touches the caller's own row;
 *   * a HelpTip opens and closes on its own.
 */

const PASSWORD = 'GuidanceTour123!';
const ORIGIN = process.env.BASE_URL || 'http://localhost:3000';
const emails: string[] = [];

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: ORIGIN,
        localStorage: [
          {
            name: COOKIE_CONSENT_KEY,
            value: JSON.stringify({ version: COOKIE_CONSENT_VERSION, necessary: true, analytics: false, marketing: false, ts: '2026-01-01T00:00:00.000Z' }),
          },
        ],
      },
    ],
  },
});

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  await prisma.$disconnect();
});

async function freshUser(prefix: string, role: 'ADMIN' | 'MENTOR') {
  const email = uniqueEmail(prefix);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, role, `${prefix} user`);
  return { email, user };
}

const tourRow = (userId: string, tourId: string) =>
  prisma.userGuidanceState.findUnique({ where: { userId_key: { userId, key: `tour:${tourId}` } } });

async function activeTestId(page: Page) {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);
}

test('a new admin is offered the tour once, completes it by keyboard, and is never offered it again', async ({ page, browser }) => {
  const { email, user } = await freshUser('tour-admin', 'ADMIN');
  await signInAndSettle(page, email, PASSWORD, '/admin');

  const dialog = page.getByTestId('tour-coachmark');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('tour-progress')).toHaveText('Step 1 of 4');
  await expect(dialog.getByRole('heading', { name: 'Your pipeline board' })).toBeVisible();
  // Focus lands on the primary button, and Tab stays inside the dialog.
  await expect.poll(() => activeTestId(page)).toBe('tour-next');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tour-coachmark"]'))).toBe(true);
  }

  // The open coachmark passes axe.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="tour-coachmark"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  // Keyboard only: Enter on the primary button through every step.
  for (const step of ['Step 2 of 4', 'Step 3 of 4', 'Step 4 of 4']) {
    await page.getByTestId('tour-next').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tour-progress')).toHaveText(step);
  }
  await expect(page.getByTestId('tour-next')).toHaveText('Done');
  await page.getByTestId('tour-next').focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await tourRow(user.id, 'admin-first-run'))?.seenAt ?? null).not.toBeNull();

  // A wiped browser: nothing in storage but the cookie choice. Not offered again.
  const wiped = await browser.newContext();
  try {
    const p2 = await wiped.newPage();
    await signInAndSettle(p2, email, PASSWORD, '/admin');
    await p2.waitForTimeout(1500);
    await expect(p2.getByTestId('tour-coachmark')).toHaveCount(0);
  } finally {
    await wiped.close();
  }
});

test('Escape skips a new mentor’s tour, records it, and it stays skipped', async ({ page }) => {
  const { email, user } = await freshUser('tour-mentor', 'MENTOR');
  await signInAndSettle(page, email, PASSWORD, '/mentor');
  const dialog = page.getByTestId('tour-coachmark');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tour-progress')).toHaveText('Step 1 of 3');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await tourRow(user.id, 'mentor-first-run'))?.dismissedAt ?? null).not.toBeNull();
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(dialog).toHaveCount(0);
});

test('under prefers-reduced-motion the coachmark does not animate, and "Skip tour" ends it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { email, user } = await freshUser('tour-motion', 'ADMIN');
  await signInAndSettle(page, email, PASSWORD, '/admin');
  const dialog = page.getByTestId('tour-coachmark');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // The app's reduced-motion rule (globals.css) pins every duration to 0.01ms
  // — "instant", not 0 — and the coachmark's own transitions are motion-safe only.
  const durations = await dialog.evaluate((el) => window.getComputedStyle(el).transitionDuration);
  const seconds = (d: string) => (d.trim().endsWith('ms') ? parseFloat(d) / 1000 : parseFloat(d));
  expect(durations.split(',').every((d) => seconds(d) <= 0.00001)).toBe(true);
  await page.getByTestId('tour-skip').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await tourRow(user.id, 'admin-first-run'))?.dismissedAt ?? null).not.toBeNull();
});

test('/api/guidance reads and writes the caller’s own state only — an ADMIN included', async ({ page }) => {
  const { email, user } = await freshUser('tour-api-admin', 'ADMIN');
  const other = await freshUser('tour-api-other', 'MENTOR');
  expect((await page.request.get('/api/guidance')).status()).toBe(401);
  await signInAndSettle(page, email, PASSWORD, '/admin');

  // A userId in the body is not a field: refused whole, nothing written for anybody.
  const forged = await page.request.post('/api/guidance', { data: { tourId: 'mentor-first-run', outcome: 'completed', userId: other.user.id } });
  expect(forged.status()).toBe(400);
  expect(await tourRow(other.user.id, 'mentor-first-run')).toBeNull();
  expect((await page.request.post('/api/guidance', { data: { tourId: 'not-a-tour', outcome: 'completed' } })).status()).toBe(400);

  const ok = await page.request.post('/api/guidance', { data: { tourId: 'admin-first-run', outcome: 'dismissed' } });
  expect(ok.status()).toBe(200);
  expect((await tourRow(user.id, 'admin-first-run'))?.dismissedAt).not.toBeNull();
  expect(await prisma.userGuidanceState.count({ where: { userId: other.user.id } })).toBe(0);
  const states = await (await page.request.get('/api/guidance')).json();
  expect(states.tours).toMatchObject({ 'admin-first-run': 'dismissed', 'mentor-first-run': 'new' });
});

test('a HelpTip opens its explanation and Escape closes it', async ({ page }) => {
  const { email, user } = await freshUser('tour-helptip', 'ADMIN');
  // Already toured, so nothing covers the board.
  await prisma.userGuidanceState.create({ data: { userId: user.id, key: 'tour:admin-first-run', seenAt: new Date() } });
  await signInAndSettle(page, email, PASSWORD, '/admin');
  await gotoSettled(page, '/admin/board');
  const button = page.getByTestId('helptip-board');
  const text = page.getByTestId('helptip-board-text');
  await expect(text).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(text).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(text).toBeHidden();
  await expect.poll(() => activeTestId(page)).toBe('helptip-board');
});
