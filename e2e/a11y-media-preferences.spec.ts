import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * OS accessibility media preferences (#2045).
 *
 * Until this spec landed, a repo-wide grep for `prefers-reduced-motion`,
 * `prefers-contrast` and `forced-colors` returned nothing at all — someone with
 * a vestibular disorder who asked their OS to reduce motion, and someone on
 * Windows High Contrast, got exactly the same CSS as everyone else. axe does
 * not flag any of that (it scans one rendering, with no preference emulated),
 * so the clean a11y baseline was actively hiding it.
 *
 * The support lives in the media-preference block at the end of
 * `src/app/globals.css`. This spec asserts the three things that block has to
 * get right, in the order they break:
 *
 *   1. reduced motion removes the ANIMATION, not the behaviour — the mobile
 *      drawer still opens and closes, it just arrives instantly;
 *   2. under forced colors the keyboard focus ring is still visible (its
 *      authored #2563eb is discarded by the forced palette, so it has to name
 *      the system `Highlight` colour instead);
 *   3. none of the three preferences may break the layout — same
 *      no-sideways-scroll rule as `mobile-layout-audit.spec.ts`.
 *
 * Not @smoke: the PR gate stays on the critical product flows.
 */

const PHONE = { width: 360, height: 800 };

/**
 * One preference at a time. `emulateMedia` merges into whatever is already
 * emulated, so each entry spells out all three — otherwise the second
 * iteration would silently be "reduced motion AND high contrast".
 */
const PREFERENCES = [
  { reducedMotion: 'reduce', contrast: null, forcedColors: null },
  { reducedMotion: null, contrast: 'more', forcedColors: null },
  { reducedMotion: null, contrast: null, forcedColors: 'active' },
] as const;
const PASSWORD = 'MediaPrefs123!';

const mentorEmail = uniqueEmail('media-prefs-mentor');

test.beforeAll(async () => {
  await cleanupByEmail(mentorEmail);
  await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Media Prefs Mentor');
});

test.afterAll(async () => {
  await cleanupByEmail(mentorEmail);
  await prisma.$disconnect();
});

/** Rule 1 of the mobile layout audit, reused: the page must not scroll sideways. */
async function scrollsSideways(page: Page) {
  return page.evaluate(() => {
    // 1px of slack: sub-pixel rounding on a scaled layout is not an overflow.
    const width = document.documentElement.scrollWidth;
    return width > window.innerWidth + 1 ? `${width}px > ${window.innerWidth}px` : null;
  });
}

/** Seconds, from a computed `transition-duration` such as "0.2s" or "0.01ms". */
function toSeconds(value: string) {
  const first = value.split(',')[0].trim();
  const n = parseFloat(first);
  return first.endsWith('ms') ? n / 1000 : n;
}

test.describe('prefers-reduced-motion', () => {
  test('the mobile drawer still opens and closes, without animating', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    // Guard the emulation itself: without this a broken `emulateMedia` would
    // surface as a confusing "duration is 0.2s" failure below.
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      'prefers-reduced-motion is not actually emulated',
    ).toBe(true);

    const drawer = page.getByTestId('mobile-drawer');
    await expect(drawer).toHaveAttribute('data-open', 'false');

    // The blanket rule collapses the 200ms transition to ~0. Anything under
    // 50ms is "no perceptible animation"; the authored value is 0.2s, so a
    // regression that drops the rule fails this by 4x.
    const duration = toSeconds(
      await drawer.evaluate((el) => getComputedStyle(el).transitionDuration),
    );
    expect(duration).toBeLessThan(0.05);

    // Off-canvas while closed (-translate-x-full on a 256px-wide drawer).
    const closedBox = await drawer.boundingBox();
    expect(closedBox!.x).toBeLessThan(0);

    // ...and the state change itself still works, in both directions.
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(drawer).toHaveAttribute('data-open', 'true');
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);

    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(drawer).toHaveAttribute('data-open', 'false');
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBeLessThan(0);
  });

  test('skeleton placeholders stay visible once the pulse is frozen', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    // The pulse is a skeleton's only affordance, so freezing it must not leave
    // an invisible block. Rendered standalone here: a live skeleton is by
    // definition transient, and what is under test is the CSS, not the fetch
    // that happens to show it.
    const style = await page.evaluate(() => {
      const el = document.createElement('div');
      // Exactly what <Skeleton> renders, minus the size utilities (those are
      // passed in per call site, and a class Tailwind never compiled is noise).
      el.className = 'ui-skeleton animate-pulse rounded bg-gray-100';
      el.style.width = '160px';
      el.style.height = '12px';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, shadow: cs.boxShadow };
    });

    // Stronger than the default bg-gray-100 (#f3f4f6) fill...
    const [r, g, b] = style.background.match(/\d+(\.\d+)?/g)!.map(Number);
    expect(Math.max(r, g, b)).toBeLessThan(240);
    // ...and drawn with a ring so the block reads as a placeholder, not a gap.
    expect(style.shadow).toContain('inset');
  });
});

test.describe('forced-colors', () => {
  test('the keyboard focus ring survives the forced palette', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');

    // `:focus-visible` only matches keyboard focus, so drive it from the
    // keyboard. Tab until one of the element types the focus-ring rule names
    // holds focus — the first stop can be a skip link or a wrapper.
    let ring: { tag: string; style: string; width: string; color: string } | null = null;
    for (let i = 0; i < 12 && !ring; i++) {
      await page.keyboard.press('Tab');
      ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.matches('a, button, [role="button"], input, select, textarea')) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
      });
    }

    expect(ring, 'no focusable a/button reached within 12 tabs').not.toBeNull();
    expect(ring!.style).not.toBe('none');
    expect(parseFloat(ring!.width)).toBeGreaterThanOrEqual(2);
    // Not transparent — a ring painted in the page background is no ring.
    expect(ring!.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('the accent swatches keep their colours (the fill IS the content)', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await gotoSettled(page, '/account');

    const swatches = page.locator('.accent-swatch');
    await expect(swatches.first()).toBeVisible();

    const adjust = await swatches.first().evaluate(
      (el) => getComputedStyle(el).forcedColorAdjust,
    );
    expect(adjust).toBe('none');

    // The whole point: six colour choices must not collapse into one system
    // colour. Distinct fills is the assertion, not any particular fill.
    const fills = await swatches.evaluateAll(
      (els) => els.map((el) => getComputedStyle(el).backgroundColor),
    );
    expect(fills.length).toBeGreaterThan(1);
    expect(new Set(fills).size).toBe(fills.length);
  });
});

test.describe('layout holds under every preference', () => {
  test('the landing page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize(PHONE);
    for (const media of PREFERENCES) {
      await page.emulateMedia(media);
      await page.goto('/');
      await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible' });
      expect(await scrollsSideways(page), `landing under ${JSON.stringify(media)}`).toBeNull();
    }
  });

  test('a signed-in page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    for (const media of PREFERENCES) {
      await page.emulateMedia(media);
      await page.reload();
      await page.getByTestId('account-menu-button').waitFor({ state: 'visible', timeout: 20_000 });
      // Every list here renders SkeletonRows while it fetches; measuring a
      // half-empty page measures nothing (see mobile-layout-audit.spec.ts).
      await expect
        .poll(async () => page.locator('.animate-pulse').count(), { timeout: 20_000 })
        .toBe(0);
      expect(await scrollsSideways(page), `/mentor under ${JSON.stringify(media)}`).toBeNull();
    }
  });
});
