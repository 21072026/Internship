import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

/**
 * Every cookie gone — the accent cookie included, which is what "another device"
 * means below — with the page torn down FIRST. Clearing cookies under a live
 * page let its `/api/auth/session` poll re-issue the session cookie, so
 * /auth/signin redirected the second sign-in to the previous user's portal
 * while the email field was being filled ("element was detached", #3059).
 * signInAsFreshUser then drops the session cookie once more, for the same race.
 */
async function signOutCompletely(page: import('@playwright/test').Page) {
  await page.goto('about:blank');
  await page.context().clearCookies();
}

test('a user can pick an accent color; it applies live and persists across reloads', async ({ page }) => {
  const email = uniqueEmail('accent');
  const pw = 'AccentPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Accent Mentee');

  try {
    await signIn(page, email, pw, '/portal');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({ timeout: 10_000 });

    const html = page.locator('html');
    // Test build isn't the preview env, so the default accent is blue.
    await expect(html).toHaveAttribute('data-accent', 'blue');

    // Pick "Purple" — the swatch is a radio labelled by its color name.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/profile') && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('radio', { name: 'Purple' }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();

    // Applies instantly, without a reload.
    await expect(html).toHaveAttribute('data-accent', 'purple');

    // Persisted to the account.
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))?.accentColor, { timeout: 10_000 })
      .toBe('purple');

    // And survives a full reload (SSR reads the cookie / saved preference).
    await page.reload();
    await expect(html).toHaveAttribute('data-accent', 'purple');
  } finally {
    await cleanupByEmail(email);
  }
});

// Regression (#2492): the profile validator used to carry its own copy of the
// colour list, so the newest swatch was pickable in the UI and rejected by the
// API with a 400 — the swatch flipped and quietly flipped back. Pick the newest
// colour rather than a long-standing one so a future addition trips this too.
test('the newest accent (magenta) is accepted by the profile API and persists', async ({ page }) => {
  const email = uniqueEmail('accent-magenta');
  const pw = 'AccentPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Magenta Mentee');

  try {
    await signIn(page, email, pw, '/portal');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({ timeout: 10_000 });

    const done = page.waitForResponse(
      (r) => r.url().includes('/api/profile') && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('radio', { name: 'Magenta' }).click();
    const res = await done;
    expect(res.status(), await res.text()).toBe(200);

    await expect(page.locator('html')).toHaveAttribute('data-accent', 'magenta');
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))?.accentColor, { timeout: 10_000 })
      .toBe('magenta');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'magenta');
  } finally {
    await cleanupByEmail(email);
  }
});

// The organization's accent (#1666, shipped as #2922): a brand colour alone
// does not recolour anyone — the organization opts in with brandAccent='brand',
// and the ramp is then derived from that one colour (no stored palette). A
// member's own accent still wins over the organization's, across a reload.
test('an organization that opts into its brand colour paints its members; their own accent still wins', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const quiet = await prisma.organization.create({ data: { name: `Accent Quiet ${stamp}`, slug: `accent-quiet-${stamp}`, brandColor: '#7c2d12' } });
  const branded = await prisma.organization.create({
    data: { name: `Accent Brand ${stamp}`, slug: `accent-brand-${stamp}`, brandColor: '#7c2d12', brandAccent: 'brand' },
  });
  const quietEmail = uniqueEmail('accent-org-quiet');
  const email = uniqueEmail('accent-org-brand');
  const pw = 'AccentPass123';
  await seedUser(quietEmail, pw, 'MENTEE', 'Quiet Org Mentee', quiet.id);
  const user = await seedUser(email, pw, 'MENTEE', 'Brand Org Mentee', branded.id);
  const html = page.locator('html');

  try {
    // A brand colour on its own: the vertical's default accent, no palette.
    await signIn(page, quietEmail, pw, '/portal');
    await page.goto('/account');
    await expect(html).toHaveAttribute('data-accent', 'blue');
    expect(await html.getAttribute('style') ?? '').not.toMatch(/--brand-600/);
    await signOutCompletely(page);

    // Opted in: the brand accent, its ramp derived from the one colour.
    await signInAsFreshUser(page, email, pw, '/portal');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(html).toHaveAttribute('data-accent', 'brand');
    expect(await html.getAttribute('style')).toMatch(/--brand-600:\s*#[0-9a-f]{6}/);

    // The member picks their own accent: it applies, persists, and the
    // organization's default does not take it back on a reload.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/profile') && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('radio', { name: 'Teal' }).click();
    expect((await done).status()).toBe(200);
    await expect(html).toHaveAttribute('data-accent', 'teal');
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))?.accentColor, { timeout: 10_000 })
      .toBe('teal');
    await page.reload();
    await expect(html).toHaveAttribute('data-accent', 'teal');

    // On another device (no accent cookie) the saved choice still wins.
    await signOutCompletely(page);
    await signInAsFreshUser(page, email, pw, '/portal');
    await expect(html).toHaveAttribute('data-accent', 'teal');
  } finally {
    await cleanupByEmail(quietEmail);
    await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [quiet.id, branded.id] } } });
  }
});
