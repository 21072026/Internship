import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Global search as an accessible combobox (#2075): dark-mode surfaces, ARIA
// semantics, keyboard traversal and a "no results" row.

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Parse a computed `rgb()` / `rgba()` string into [r, g, b]. */
function rgb(value: string): [number, number, number] {
  const [r, g, b] = value.match(/\d+(\.\d+)?/g)!.map(Number);
  return [r, g, b];
}

/** WCAG relative luminance of an sRGB triple. */
function luminance([r, g, b]: [number, number, number]) {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(fg: string, bg: string) {
  const [a, b] = [luminance(rgb(fg)), luminance(rgb(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/**
 * Force dark mode. Same technique as e2e/a11y-scan.spec.ts: reload rather than
 * toggling the class on a page already rendered light, so the server and the
 * no-flash theme script both commit to dark before anything is measured.
 */
async function forceDark(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    document.cookie = 'theme=dark; path=/; max-age=31536000';
    try { localStorage.setItem('theme', 'dark'); } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 10_000 });
}

async function signInAsAdmin(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

/** Type into the global search and wait for the debounced request to settle. */
async function search(page: Page, term: string) {
  const response = page.waitForResponse((r) => r.url().includes('/api/search') && r.url().includes(encodeURIComponent(term).slice(0, 6)));
  await page.getByTestId('global-search-input').fill(term);
  await response;
  await expect(page.getByTestId('global-search-panel')).toBeVisible({ timeout: 10_000 });
}

test('global search: combobox semantics, keyboard traversal and no-results row', async ({ page }) => {
  const adminEmail = uniqueEmail('gscombo');
  const password = 'AdminPass123';
  await seedUser(adminEmail, password, 'ADMIN', 'Combo Admin');
  const a = await seedUser(uniqueEmail('gscomboa'), 'x', 'MENTEE', 'Vorplex Aardwing');
  const b = await seedUser(uniqueEmail('gscombob'), 'x', 'MENTEE', 'Vorplex Bramblehush');

  try {
    await signInAsAdmin(page, adminEmail, password);

    const input = page.getByTestId('global-search-input');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-expanded', 'false');

    await search(page, 'Vorplex');

    const listbox = page.getByTestId('global-search-listbox');
    await expect(listbox).toHaveAttribute('role', 'listbox');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'global-search-listbox');
    // No option is active until the user arrows into the list.
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();

    const first = page.getByTestId(`global-search-option-user-${a.id}`);
    const second = page.getByTestId(`global-search-option-user-${b.id}`);

    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${a.id}`);
    await expect(first).toHaveAttribute('aria-selected', 'true');

    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${b.id}`);
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('aria-selected', 'false');

    // ArrowUp walks back, and wraps past the top to the last option.
    await input.press('ArrowUp');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${a.id}`);
    await input.press('ArrowUp');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${b.id}`);

    // Home / End jump to the ends.
    await input.press('Home');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${a.id}`);
    await input.press('End');
    await expect(input).toHaveAttribute('aria-activedescendant', `global-search-option-user-${b.id}`);

    // The polite live region carries the result count.
    await expect(page.getByTestId('global-search-status')).toHaveText(/2/);

    // Escape closes the panel without navigating and leaves focus on the input.
    await input.press('Escape');
    await expect(page.getByTestId('global-search-panel')).toHaveCount(0);
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toBeFocused();

    // A query with no matches shows a localised row instead of nothing at all.
    await search(page, 'Zzqqxxnomatchhere');
    await expect(page.getByTestId('global-search-empty')).toBeVisible();
    await expect(page.getByTestId('global-search-listbox')).toHaveCount(0);

    // Enter on the highlighted option navigates to that candidate.
    await search(page, 'Vorplex Aardwing');
    await input.press('ArrowDown');
    await input.press('Enter');
    await page.waitForURL((u) => u.pathname === `/admin/candidates/${a.id}`, { timeout: 15_000 });
  } finally {
    await cleanupByEmail(a.email);
    await cleanupByEmail(b.email);
    await cleanupByEmail(adminEmail);
  }
});

test('global search dropdown is readable in dark mode (computed style, both themes)', async ({ page }) => {
  const adminEmail = uniqueEmail('gsdark');
  const password = 'AdminPass123';
  await seedUser(adminEmail, password, 'ADMIN', 'Dark Admin');
  const mentee = await seedUser(uniqueEmail('gsdarkm'), 'x', 'MENTEE', 'Krendal Duskwither');

  try {
    await signInAsAdmin(page, adminEmail, password);

    // --- Light: the panel is a light surface with dark text. ---
    await search(page, 'Krendal');
    let panelBg = await page.getByTestId('global-search-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
    let nameColor = await page.getByTestId(`global-search-option-user-${mentee.id}`)
      .locator('span').first().evaluate((el) => getComputedStyle(el).color);
    expect(luminance(rgb(panelBg))).toBeGreaterThan(0.5);
    expect(contrast(nameColor, panelBg)).toBeGreaterThan(4.5);

    // --- Dark: the same surfaces must flip, not stay a white slab. ---
    await forceDark(page);
    await search(page, 'Krendal');

    const panel = page.getByTestId('global-search-panel');
    panelBg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = rgb(panelBg);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(70);

    const option = page.getByTestId(`global-search-option-user-${mentee.id}`);
    nameColor = await option.locator('span').first().evaluate((el) => getComputedStyle(el).color);
    const metaColor = await option.locator('span').last().evaluate((el) => getComputedStyle(el).color);
    // AA for normal text on the name, AA for the small meta line too.
    expect(contrast(nameColor, panelBg)).toBeGreaterThan(4.5);
    expect(contrast(metaColor, panelBg)).toBeGreaterThan(4.5);

    // The keyboard-active row stays readable against its own (darker) tint.
    await page.getByTestId('global-search-input').press('ArrowDown');
    const activeBg = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(rgb(activeBg))).toBeLessThan(0.2);
    expect(contrast(nameColor, activeBg)).toBeGreaterThan(4.5);
  } finally {
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(adminEmail);
  }
});
