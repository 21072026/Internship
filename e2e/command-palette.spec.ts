import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
  await shortcutsReady(page);
}

/**
 * Wait until the palette's global keydown listener is attached (#2480).
 *
 * `waitForURL` resolves on the landing page's `load` event, and on a busy shard
 * React is often still hydrating then. The shortcuts are a `document` listener
 * added in a `useEffect`, so a key pressed in that window reaches nobody and is
 * gone: the test pressed Ctrl+K / ? exactly once and then waited the full 15s
 * expect timeout for a dialog that could never open (16.1-16.2s in 2 of 3
 * scheduled runs). `CommandPalette` sets `<html data-shortcuts="ready">` in the
 * same effect that registers the listener, so this waits for the real signal.
 * It also stops the "Ctrl+K in an input does nothing" assertion from passing
 * just because nothing was listening yet.
 */
async function shortcutsReady(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'ready', { timeout: 20_000 });
}

// ⌘K / Ctrl+K command palette (#2079). The runner is Linux, so Control is the
// modifier under test; the handler accepts either.
test('command palette opens on Ctrl+K and navigates by keyboard', async ({ page }) => {
  const email = uniqueEmail('palette-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Palette Admin');

  try {
    await signIn(page, email, 'AdminPass123', '/admin');

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    // The input takes focus so typing goes straight into the query.
    await expect(page.getByTestId('command-palette-input')).toBeFocused();

    // Typing filters the role-scoped "Go to" list.
    await page.getByTestId('command-palette-input').fill('Companies');
    const companies = page.getByTestId('command-palette-option-goto-admin-companies');
    await expect(companies).toBeVisible();

    // Arrow to the first option and open it with Enter — no mouse involved.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await expect(companies).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    await page.waitForURL((u) => u.pathname === '/admin/companies', { timeout: 20_000 });
    await expect(palette).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('Escape closes the palette and restores focus to where it was', async ({ page }) => {
  const email = uniqueEmail('palette-esc');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Palette Escape');

  try {
    await signIn(page, email, 'AdminPass123', '/admin');

    // ⌘K must not fire while the caret is in an input — the header search keeps it.
    const header = page.getByTestId('global-search-input');
    await header.focus();
    await expect(header).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);

    // From a non-typing element it opens, and closing puts focus back there.
    const link = page.locator('nav').getByRole('link', { name: 'Companies', exact: true });
    await link.focus();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(link).toBeFocused();
  } finally {
    await cleanupByEmail(email);
  }
});

test('? opens the shortcut sheet with the platform modifier label', async ({ page }) => {
  const email = uniqueEmail('palette-help');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Palette Mentor');

  try {
    await signIn(page, email, 'MentorPass123', '/mentor');

    await page.keyboard.press('?');
    const sheet = page.getByTestId('shortcuts-sheet');
    await expect(sheet).toBeVisible();

    // The rows are generated from lib/shortcuts, so every registered binding is
    // listed. On the Linux runner the modifier renders as Ctrl, not ⌘.
    const openPalette = page.getByTestId('shortcut-openPalette');
    await expect(openPalette).toContainText('Ctrl');
    await expect(openPalette).toContainText('K');
    await expect(page.getByTestId('shortcut-dismiss')).toContainText('Esc');

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});
