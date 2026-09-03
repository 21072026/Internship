import { test, expect, type Page } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * OS-level accessibility preferences (#2045).
 *
 * The browser tells us three things about the person in front of it, and until
 * this spec existed the app ignored all three. axe never flagged any of it —
 * these are exactly the checks an auditor runs by hand after reading a
 * conformance statement, which is why they are asserted mechanically here.
 *
 * Playwright emulates all three, so no OS setting is involved:
 *   page.emulateMedia({ reducedMotion: 'reduce' })
 *   page.emulateMedia({ contrast: 'more' })
 *   page.emulateMedia({ forcedColors: 'active' })
 *
 * The rules under test live at the end of src/app/globals.css. Not @smoke: the
 * PR gate stays small, this is scheduled-suite coverage.
 */

const PHONE = { width: 360, height: 800 };

/** Seconds in a computed `transition-duration` / `animation-duration` string. */
function seconds(value: string): number {
  const first = value.split(',')[0].trim();
  if (first.endsWith('ms')) return parseFloat(first) / 1000;
  return parseFloat(first) || 0;
}

/** Relative-luminance-ish score of an `rgb(...)` string; lower = darker. */
function brightness(rgb: string): number {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The page itself must never scroll sideways (same rule as mobile-layout-audit). */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('prefers-reduced-motion', () => {
  test('neutralises transitions on the public page', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    // The audience cards carry `transition-all`; under the blanket rule their
    // duration collapses to ~0 instead of the Tailwind default.
    const duration = await page.locator('.transition-all').first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(seconds(duration)).toBeLessThan(0.05);

    await expectNoSidewaysScroll(page);
  });

  test('the mobile drawer still opens and closes without its slide animation', async ({ page }) => {
    const email = uniqueEmail('a11y-motion');
    const password = 'TestPass123!';
    await seedUser(email, password, 'MENTOR', 'Reduced Motion Mentor');
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // Sign in at the default viewport, then shrink: the drawer only exists
      // below `lg`, and this keeps the login flow off the mobile shell.
      await signInAndSettle(page, email, password, '/mentor');
      await page.setViewportSize(PHONE);

      const drawer = page.getByTestId('app-drawer');

      // The animation is gone …
      const duration = await drawer.evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(seconds(duration)).toBeLessThan(0.05);

      // … but the behaviour is not: closed it sits off-screen to the left,
      // open it sits flush against it, and it goes back when dismissed.
      const closedBox = await drawer.boundingBox();
      expect(closedBox!.x).toBeLessThan(-100);

      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect.poll(async () => (await drawer.boundingBox())!.x).toBeCloseTo(0, 0);

      await page.getByRole('button', { name: 'Close menu' }).click();
      await expect.poll(async () => (await drawer.boundingBox())!.x).toBeLessThan(-100);
    } finally {
      await cleanupByEmail(email);
    }
  });
});

test.describe('prefers-contrast: more', () => {
  test('borders and secondary text get stronger', async ({ page }) => {
    await page.goto('/');

    const probe = async () => {
      const border = await page.locator('.border-gray-200').first()
        .evaluate((el) => getComputedStyle(el).borderTopColor);
      const text = await page.locator('.text-gray-500').first()
        .evaluate((el) => getComputedStyle(el).color);
      return { border: brightness(border), text: brightness(text) };
    };

    const normal = await probe();
    await page.emulateMedia({ contrast: 'more' });
    const boosted = await probe();

    // Light theme: "stronger" means darker against the light page background.
    expect(boosted.border).toBeLessThan(normal.border);
    expect(boosted.text).toBeLessThan(normal.text);

    await expectNoSidewaysScroll(page);
  });
});

test.describe('forced-colors: active', () => {
  test('the keyboard focus ring survives colour flattening', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');

    // Tab (not .focus()) so :focus-visible actually matches — Chromium only
    // paints the ring when the last interaction was a keyboard one.
    await page.keyboard.press('Tab');

    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0 };
    });

    expect(ring).not.toBeNull();
    expect(ring!.style).toBe('solid');
    expect(ring!.width).toBeGreaterThanOrEqual(2);

    await expectNoSidewaysScroll(page);
  });
});
