import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, statSync } from 'fs';
import path from 'path';

/**
 * Release-note media capture (#2233) — a PRODUCER, not a test.
 *
 * Everything else under e2e/ verifies behaviour. This file makes the picture a
 * release note carries: it drives the screen the change is about and writes the
 * result into public/release-media/, where the release fragment points at it
 * (releases/README.md -> "Media on a release note").
 *
 * IT DOES NOT RUN IN CI. Not in the PR smoke gate, and not in the scheduled
 * full suite: playwright.config.ts only declares the `release-media` project
 * when CAPTURE_RELEASE_MEDIA is set, and the default `chromium` project ignores
 * this file. A capture job that ran on its own would silently rewrite committed
 * bytes on someone else's PR; the author captures deliberately and commits the
 * result:
 *
 *     npm run test:e2e:media                      # everything below
 *     npm run test:e2e:media -- --grep "poster"   # one capture
 *
 * Deliberately NOT screenshot diffing. `e2e/mobile-chat-layout.spec.ts` states
 * the house rule — geometric assertions, never pixel comparison — and this file
 * does not change it. Nothing here asserts that an image looks like anything;
 * it only produces one.
 *
 * TWO SHAPES OF CAPTURE
 *
 *   Still  — `locator.screenshot()`, ALWAYS an element, never `page`. A cropped
 *            component is 40-80 KB (the validator caps a poster at 150 KB) and
 *            it does not churn every time unrelated page chrome moves.
 *   Clip   — Playwright's own `recordVideo`, so the output is WebM with no
 *            ffmpeg anywhere. Video is recorded per BrowserContext, whole
 *            viewport, for the WHOLE test — Playwright can neither crop it to
 *            an element nor trim it to the interesting seconds. So do not try:
 *            keep the test minimal, so the whole test *is* the thing worth
 *            showing, and keep it under five seconds (WCAG 2.2.2 — the
 *            validator rejects a longer clip).
 *
 * A still is always required; a clip almost never is. Add one only when motion
 * is the point (a drag, a reveal, a live update).
 */

const MEDIA_DIR = path.join(__dirname, '..', 'public', 'release-media');

/** Loud, because the file is the deliverable: name it and give its size. */
function report(label: string, file: string) {
  const kb = statSync(file).size / 1024;
  console.log(`captured ${label}: public/release-media/${path.basename(file)} (${kb.toFixed(0)} KB)`);
}

/**
 * One element, cropped, into public/release-media/<slug>.png.
 * `slug` is the release fragment's slug — one poster per fragment, so the name
 * cannot collide with another change's.
 */
async function capturePoster(target: Locator, slug: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${slug}.png`);
  await target.waitFor({ state: 'visible' });
  await target.screenshot({ path: file, animations: 'disabled', scale: 'css' });
  report('poster', file);
  return file;
}

/**
 * The page's recording, into public/release-media/<slug>.webm.
 *
 * The page has to be CLOSED first: Playwright finalises a video when its page
 * closes, and `video.saveAs()` waits for exactly that — calling it on a page
 * that is still open waits for the end of the test still driving it.
 */
async function captureClip(page: Page, slug: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${slug}.webm`);
  const video = page.video();
  expect(video, 'no video recorded — did the context set recordVideo?').toBeTruthy();
  await page.close();
  await video!.saveAs(file);
  report('clip', file);
  return file;
}

test.describe('release media', () => {
  // Captures are light-theme only and framed by the page, so nothing here
  // touches the theme. A fixed, modest viewport keeps a poster's pixel size
  // stable between authors and machines.
  test.use({ viewport: { width: 1100, height: 800 } });

  /**
   * TEMPLATE — a still of one component.
   *
   * Copy this test for your own change: point it at the element the release
   * note is about, and name the file after your fragment's slug. The example
   * uses a public page so it needs no seeded data; a capture of a signed-in
   * screen imports `signInAndSettle` from './helpers/auth' and seeds its own
   * user with './helpers/db', exactly like a normal spec.
   */
  test('poster: the newest release-notes card', async ({ page }) => {
    await page.goto('/release-notes');
    // The newest card, which is also the surface this very change is about.
    await capturePoster(page.getByTestId('release-card').first(), 'example-release-card');
  });

  /**
   * TEMPLATE — a clip, for a change where motion is the point.
   *
   * THE RECORDING STARTS AT `newContext()`, NOT AT THE FIRST ACTION. Everything
   * between that call and `page.close()` is in the file: the navigation, and —
   * against `npm run dev` — the several seconds Next.js spends compiling the
   * route on its first hit. That alone can push a 1.2s interaction past the
   * five-second cap and get the fragment rejected by `check:release-fragments`
   * with a message about the test being too long. So the route is warmed in the
   * ordinary `page` fixture (a separate, unrecorded context) BEFORE the
   * recording context exists.
   *
   * `size` is the video's own resolution, kept well under the viewport: the
   * clip renders at 480px wide on the page, so recording a 1100px-wide desktop
   * would only cost bytes. Keep its aspect ratio equal to the viewport's, or
   * Playwright letterboxes the picture inside the file; and crop the fragment's
   * POSTER to roughly the same shape, since the poster is what a
   * reduced-motion reader sees in the clip's place.
   *
   * Everything the test does ends up in the file, so it does nothing but the
   * one interaction worth showing — and stays under the cap by staying short,
   * not by trimming (which Playwright cannot do).
   */
  test('clip: a short interaction on the release-notes page', async ({ browser, baseURL, page: warmup }) => {
    await warmup.goto('/release-notes');

    const context = await browser.newContext({
      // A hand-built context inherits NOTHING from the project's `use` — not
      // the baseURL a relative goto() needs, and not the consent state that
      // keeps the cookie banner out of the first frame of the recording.
      baseURL,
      storageState: path.join(__dirname, '.state', 'consent.json'),
      viewport: { width: 960, height: 600 },
      recordVideo: { dir: test.info().outputDir, size: { width: 640, height: 400 } },
    });
    const page = await context.newPage();
    try {
      await page.goto('/release-notes');
      await page.getByTestId('release-notes-feed-link').hover();
      await page.waitForTimeout(1_200);
      await captureClip(page, 'example-release-motion');
    } finally {
      await context.close();
    }
  });
});
