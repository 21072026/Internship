import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// Profile completeness meter (light gamification, internship product only).
// The rule itself — fields, weights, what counts as empty — is unit-tested in
// scripts/test/profile-completeness.test.mjs; this spec pins what the mentee
// sees: a real progressbar with the computed number on /portal and at the top
// of /portal/profile, a checklist of the empty fields that jumps to each one,
// the card gone at 100%, dark-mode legibility, phone width, and that a
// MARKETING account never reaches it.

const PW = 'ProgressPass123';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const FULL_PROFILE = {
  skills: ['React', 'SQL'],
  targetPosition: 'Frontend developer',
  cvUrl: 'https://example.com/cv.pdf',
  university: 'Example University',
  department: 'Computer Engineering',
  interests: 'Accessibility',
  city: 'Ankara',
  graduationYear: 2027,
  bio: 'Short bio.',
};

async function meter(page: Page) {
  const card = page.getByTestId('profile-progress');
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

test('an empty profile shows 0% and every field; filling fields moves the bar', async ({ page }) => {
  const email = uniqueEmail('progress-empty');
  const user = await seedUser(email, PW, 'MENTEE', 'Progress Mentee');
  try {
    await signInAndSettle(page, email, PW, '/portal');
    await gotoSettled(page, '/portal');

    let card = await meter(page);
    const bar = card.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAccessibleName('Profile completeness');
    await expect(card.getByTestId('profile-progress-percent')).toHaveText('0% complete');
    await expect(card.getByTestId('profile-progress-missing').getByRole('link')).toHaveCount(9);
    // Heaviest first: skills leads the list.
    await expect(card.getByTestId('profile-progress-missing').getByRole('link').first()).toHaveText('Add your skills');
    await expect(card.getByTestId('profile-progress-item-skills')).toHaveAttribute('href', '/portal/profile#profile-field-skills');

    // Skills (25) + city (5) = 30.
    await prisma.user.update({ where: { id: user.id }, data: { skills: ['TypeScript'], city: 'Izmir' } });
    await gotoSettled(page, '/portal');
    card = await meter(page);
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    await expect(card.getByTestId('profile-progress-item-skills')).toHaveCount(0);
    await expect(card.getByTestId('profile-progress-item-city')).toHaveCount(0);
    await expect(card.getByTestId('profile-progress-missing').getByRole('link')).toHaveCount(7);

    // A checklist item jumps to that field on /portal/profile.
    await card.getByTestId('profile-progress-item-targetPosition').click();
    await page.waitForURL((u) => u.pathname === '/portal/profile' && u.hash === '#profile-field-targetPosition', { timeout: 20_000 });
    const target = page.locator('#profile-field-targetPosition');
    // Really landed there: the form loads client-side after the browser's own
    // hash scroll, so ProfileForm scrolls to the hash itself once it renders.
    // `toBeVisible` alone would pass with the field far below the fold.
    await expect(target).toBeInViewport({ timeout: 15_000 });
    await expect(target.getByRole('textbox')).toBeFocused();

    // The same meter, with the same number, sits at the top of the profile page.
    const profileCard = await meter(page);
    await expect(profileCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    // Its links are in-page anchors.
    await expect(profileCard.getByTestId('profile-progress-item-bio')).toHaveAttribute('href', '#profile-field-bio');

    // Saving a field updates the meter without a reload: +15 for the target role.
    await target.getByRole('textbox').fill('Backend developer');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(profileCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45', { timeout: 15_000 });
    await expect(profileCard.getByTestId('profile-progress-item-targetPosition')).toHaveCount(0);
    const stored = await prisma.user.findUnique({ where: { id: user.id }, select: { targetPosition: true } });
    expect(stored?.targetPosition).toBe('Backend developer');
  } finally {
    await cleanupByEmail(email);
  }
});

test('a complete profile hides the dashboard card and collapses to one line on the profile page', async ({ page }) => {
  const email = uniqueEmail('progress-full');
  const user = await seedUser(email, PW, 'MENTEE', 'Complete Mentee');
  await prisma.user.update({ where: { id: user.id }, data: FULL_PROFILE });
  try {
    await signInAndSettle(page, email, PW, '/portal');
    await gotoSettled(page, '/portal');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Complete Mentee');
    await expect(page.getByTestId('profile-progress')).toHaveCount(0);
    await expect(page.getByRole('progressbar', { name: 'Profile completeness' })).toHaveCount(0);

    await gotoSettled(page, '/portal/profile');
    await expect(page.getByTestId('profile-progress-complete')).toHaveText('Every profile field this meter tracks is filled in.', { timeout: 15_000 });
    await expect(page.getByTestId('profile-progress')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('the meter is readable in dark mode and fits a phone screen', async ({ page, context, baseURL }) => {
  const email = uniqueEmail('progress-dark');
  const user = await seedUser(email, PW, 'MENTEE', 'Dark Mentee');
  await prisma.user.update({ where: { id: user.id }, data: { skills: ['Go'], university: 'Example University' } });
  try {
    await context.addCookies([{ name: 'theme', value: 'dark', url: baseURL ?? 'http://localhost:3000' }]);
    await page.setViewportSize({ width: 360, height: 780 });
    await signInAndSettle(page, email, PW, '/portal');
    await gotoSettled(page, '/portal');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const card = await meter(page);
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');

    // WCAG contrast of each text element against the card's own background.
    const ratios = await card.evaluate((root) => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const bg = lum(parse(getComputedStyle(root).backgroundColor));
      const els = [
        root.querySelector('h2'),
        root.querySelector('[data-testid="profile-progress-percent"]'),
        root.querySelector('p'),
        root.querySelector('[data-testid="profile-progress-missing"] a'),
        root.querySelector(':scope > a'),
      ];
      return els.map((el) => {
        const fg = lum(parse(getComputedStyle(el as Element).color));
        const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      });
    });
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);

    // No horizontal scroll at 360px, and the card stays inside the viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await card.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(360);
  } finally {
    await cleanupByEmail(email);
  }
});

test('a MARKETING account never reaches the meter — /portal and /portal/profile send it to /account', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Progress MARKETING ${stamp}`, slug: `progress-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const email = uniqueEmail('progress-mkt');
  const user = await seedUser(email, PW, 'MENTEE', 'Marketing Lead');
  await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
    for (const path of ['/portal', '/portal/profile']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
      await expect(page.getByTestId('profile-progress')).toHaveCount(0);
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
