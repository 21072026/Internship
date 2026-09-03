import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #2075 — the global search combobox.
 *
 * Two defects are covered here:
 *  1. the dropdown was styled with bare `bg-white` / `text-gray-*` and rendered
 *     as a light slab in dark mode. The fix leans on the flat `html.dark`
 *     overrides in globals.css, so the regression guard has to be a *computed*
 *     colour check in both themes — a class assertion would pass either way.
 *  2. it was mouse-only: no combobox/listbox roles, no arrow keys. The keyboard
 *     traversal below is the contract: wrapping arrows, Home/End, Enter,
 *     Escape, Tab.
 *
 * The search box lives in ResponsiveShell's `hidden lg:flex` top strip, so
 * these tests need the desktop viewport the chromium project already uses.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

const rgb = (value: string) => value.match(/\d+(\.\d+)?/g)!.map(Number);

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

/** Type a query and wait for the debounced /api/search response to land. */
async function search(page: Page, query: string) {
  const response = page.waitForResponse(
    (r) => r.url().includes('/api/search') && r.url().includes(encodeURIComponent(query)),
  );
  await page.getByTestId('global-search-input').fill(query);
  await response;
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
}

test('global search dropdown is readable in both light and dark mode', async ({ page }) => {
  const adminEmail = uniqueEmail('gsa11yadmin');
  const menteeEmail = uniqueEmail('gsa11ymentee');
  const token = `Nyxthorpe${Date.now().toString(36)}`;

  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Contrast Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', `${token} Alpha`);

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    await page.emulateMedia({ colorScheme: 'light' });
    await setTheme(page, 'light');

    await search(page, token);
    const listbox = page.getByTestId('global-search-listbox');
    const option = page.getByTestId(`global-search-option-${mentee.id}`);
    await expect(listbox).toBeVisible();
    await expect(option).toBeVisible();
    // The candidate name — the strongest text tone in the row (text-gray-900).
    const name = option.locator('span').first();

    // --- Light mode: white panel, near-black name.
    const [lr, lg, lb] = rgb(await listbox.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(lr).toBeGreaterThan(240);
    expect(lg).toBeGreaterThan(240);
    expect(lb).toBeGreaterThan(240);
    const [ltr, ltg, ltb] = rgb(await name.evaluate((el) => getComputedStyle(el).color));
    expect(Math.max(ltr, ltg, ltb)).toBeLessThan(80);

    // --- Dark mode: the panel must be a dark surface (#111827), not a white
    // slab, and the name must flip to a light tone. Flipping the class does not
    // re-render or blur the input, so the panel stays open.
    await setTheme(page, 'dark');
    await expect(listbox).toBeVisible();
    const [dr, dg, db] = rgb(await listbox.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(dr).toBeLessThan(60);
    expect(dg).toBeLessThan(60);
    expect(db).toBeLessThan(70);
    const [dtr, dtg, dtb] = rgb(await name.evaluate((el) => getComputedStyle(el).color));
    expect(dtr).toBeGreaterThan(150);
    expect(dtg).toBeGreaterThan(150);
    expect(dtb).toBeGreaterThan(150);

    // The secondary tones (role badge, email) must not stay dark-on-dark either.
    const secondary = option.locator('span').nth(1);
    const [sr, sg, sb] = rgb(await secondary.evaluate((el) => getComputedStyle(el).color));
    expect(Math.min(sr, sg, sb)).toBeGreaterThan(120);

    // The keyboard-highlighted row must be distinguishable from the panel.
    await page.getByTestId('global-search-input').press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    const [hr, hg, hb] = rgb(await option.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(hr + hg + hb).toBeGreaterThan(dr + dg + db);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('global search is a keyboard-operable combobox', async ({ page }) => {
  const adminEmail = uniqueEmail('gskbdadmin');
  const emails = [uniqueEmail('gskbd1'), uniqueEmail('gskbd2'), uniqueEmail('gskbd3')];
  // A random token keeps the result set to exactly these three rows, whatever
  // else the shared DB holds. /api/search orders users by fullName ASC, so the
  // suffixes fix the option order.
  const token = `Vashtrild${Date.now().toString(36)}`;

  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Keyboard Admin');
  const [alpha, bravo, charlie] = [
    await seedUser(emails[0], 'x', 'MENTEE', `${token} Alpha`),
    await seedUser(emails[1], 'x', 'MENTEE', `${token} Bravo`),
    await seedUser(emails[2], 'x', 'MENTEE', `${token} Charlie`),
  ];

  const testId = (id: string) => `global-search-option-${id}`;

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    const input = page.getByTestId('global-search-input');

    // Closed state: a combobox that advertises no popup.
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-expanded', 'false');

    await search(page, token);
    const listbox = page.getByTestId('global-search-listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox).toHaveAttribute('role', 'listbox');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(listbox).toHaveAttribute('id', 'global-search-listbox');
    await expect(input).toHaveAttribute('aria-controls', 'global-search-listbox');
    await expect(listbox.getByRole('option')).toHaveCount(3);
    // Nothing highlighted until the user asks for it.
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();

    const expectActive = async (id: string) => {
      await expect(input).toHaveAttribute('aria-activedescendant', testId(id));
      await expect(page.getByTestId(testId(id))).toHaveAttribute('aria-selected', 'true');
    };

    // ArrowDown walks forward and wraps at the end.
    await input.press('ArrowDown');
    await expectActive(alpha.id);
    await input.press('ArrowDown');
    await expectActive(bravo.id);
    await input.press('ArrowDown');
    await expectActive(charlie.id);
    await input.press('ArrowDown');
    await expectActive(alpha.id);

    // ArrowUp wraps backwards off the first row.
    await input.press('ArrowUp');
    await expectActive(charlie.id);
    await input.press('ArrowUp');
    await expectActive(bravo.id);

    // Home/End jump to the ends.
    await input.press('End');
    await expectActive(charlie.id);
    await input.press('Home');
    await expectActive(alpha.id);

    // Escape closes the panel, drops the highlight and keeps focus on the input.
    await input.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();
    await expect(input).toBeFocused();

    // ArrowDown reopens the panel on the still-current query.
    await input.press('ArrowDown');
    await expect(listbox).toBeVisible();
    await expectActive(alpha.id);

    // Tab leaves the widget without navigating: the options are not tab stops.
    await input.press('Tab');
    await expect(listbox).toBeHidden();
    await expect(input).not.toBeFocused();
    expect(new URL(page.url()).pathname).toMatch(/^\/admin/);

    // Enter on the highlighted option navigates to that candidate. Refocusing
    // reopens the panel on the unchanged query — deliberately not a second
    // fill(), which would set the same value, fire no state change and so never
    // produce another /api/search response to wait for.
    await input.focus();
    await expect(listbox).toBeVisible();
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expectActive(bravo.id);
    await input.press('Enter');
    await page.waitForURL((u) => u.pathname === `/admin/candidates/${bravo.id}`, { timeout: 15_000 });
  } finally {
    for (const email of emails) await cleanupByEmail(email);
    await cleanupByEmail(adminEmail);
  }
});

test('global search announces its result count and shows a no-results row', async ({ page }) => {
  const adminEmail = uniqueEmail('gslivedadmin');
  const menteeEmail = uniqueEmail('gslivedmentee');
  const token = `Grumwaldis${Date.now().toString(36)}`;

  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Live Region Admin');
  await seedUser(menteeEmail, 'x', 'MENTEE', `${token} Solo`);

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    const live = page.getByTestId('global-search-status');
    await expect(live).toHaveAttribute('aria-live', 'polite');

    await search(page, token);
    await expect(page.getByTestId('global-search-listbox')).toBeVisible();
    // One hit → the count is announced (EN is the default locale).
    await expect(live).toHaveText('1 results');

    // A query that matches nothing renders an explicit row instead of an empty
    // popup — previously the panel simply did not render and the box looked broken.
    await search(page, `${token}zzqx`);
    const empty = page.getByTestId('global-search-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('No results');
    await expect(live).toHaveText('No results');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
