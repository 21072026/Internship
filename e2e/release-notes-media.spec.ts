import { test, expect, type Page } from '@playwright/test';

/**
 * How a release note's optional screenshot/clip RENDERS (#2233).
 *
 * The capture side lives in e2e/release-media.spec.ts, which does not run in
 * CI. This is the ordinary side: given a release note that carries media, the
 * page must show it small, framed, with localized alternative text, without
 * shifting the layout — and must show the POSTER, not a muted video, to a
 * reader who has asked for reduced motion.
 *
 * SELF-SKIPPING BY DESIGN. Media is permanently optional, and most releases
 * ship none, so there are stretches where /release-notes has nothing to assert
 * on. A skip then is the honest outcome: failing would mean "every release must
 * carry a screenshot", which is exactly the rule this feature refuses to make.
 * Not @smoke — scheduled-suite coverage.
 */

const MAX_WIDTH = 480;

async function setLocale(page: Page, locale: 'tr' | 'de') {
  await page.goto('/release-notes');
  await page.evaluate((l) => {
    document.cookie = `locale=${l};path=/`;
  }, locale);
  await page.goto('/release-notes');
}

test.describe('release-note media', () => {
  test('renders small, framed and described, without shifting the layout', async ({ page }) => {
    await page.goto('/release-notes');
    const figures = page.getByTestId('release-media');
    const count = await figures.count();
    test.skip(count === 0, 'no release note currently carries media');

    for (let i = 0; i < count; i += 1) {
      const figure = figures.nth(i);
      const box = await figure.boundingBox();
      expect(box, 'the media frame is laid out').not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(MAX_WIDTH + 1);

      // Framed: a light capture on the dark page has to read as a screenshot
      // rather than as part of the card.
      const border = await figure.evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: parseFloat(style.borderTopWidth), color: style.borderTopColor };
      });
      expect(border.width).toBeGreaterThan(0);
      expect(border.color).not.toBe('rgba(0, 0, 0, 0)');

      // Reserved space: the intrinsic size is on the element, so the list does
      // not jump when the bytes arrive.
      const media = figure.locator('img, video').first();
      const attrs = await media.evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        width: el.getAttribute('width'),
        height: el.getAttribute('height'),
        alt: el.getAttribute('alt') ?? el.getAttribute('aria-label'),
      }));
      expect(Number(attrs.width)).toBeGreaterThan(0);
      expect(Number(attrs.height)).toBeGreaterThan(0);
      expect(attrs.alt?.trim()).toBeTruthy();
    }
  });

  test('shows the poster, not a video, under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/release-notes');
    const figures = page.getByTestId('release-media');
    test.skip((await figures.count()) === 0, 'no release note currently carries media');

    await expect(page.getByTestId('release-media-poster').first()).toBeVisible();
    // Not a paused video: no <video> is mounted at all, so the WebM is never
    // even fetched (WCAG 2.2.2 and the OS preference, honoured properly).
    await expect(page.locator('[data-testid="release-media"] video')).toHaveCount(0);
  });

  test('the alternative text follows the reader\'s language', async ({ page }) => {
    await page.goto('/release-notes');
    const figures = page.getByTestId('release-media');
    test.skip((await figures.count()) === 0, 'no release note currently carries media');

    const describedIn = async () =>
      page
        .locator('[data-testid="release-media"] img, [data-testid="release-media"] video')
        .first()
        .evaluate((el) => el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '');

    const en = await describedIn();
    await setLocale(page, 'tr');
    const tr = await describedIn();
    await setLocale(page, 'de');
    const de = await describedIn();

    for (const text of [en, tr, de]) expect(text.trim()).toBeTruthy();
    // Three locales are mandatory on the fragment, so at least one of them has
    // to actually differ — identical strings would mean the alt is not localized
    // (or that someone pasted the English into all three).
    expect(new Set([en, tr, de]).size).toBeGreaterThan(1);
  });
});
