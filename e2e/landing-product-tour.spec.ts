import { test, expect, type Page } from '@playwright/test';

// The landing's product tour (#1399): three real screenshots, each in the
// visitor's theme and for their device. Not a pixel comparison (house rule) —
// it asserts what the visitor is served: three described images, and only the
// files that match their theme and screen are downloaded.

const SCREENS = ['mentee', 'mentor', 'company'] as const;

/** Scroll every figure into view (the images are lazy) and return the screenshot files fetched. */
async function loadTour(page: Page) {
  const fetched: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/screenshots/')) {
      expect(r.status(), r.url()).toBe(200);
      fetched.push(new URL(r.url()).pathname.split('/').pop()!);
    }
  });
  await page.goto('/');
  for (const s of SCREENS) {
    const figure = page.getByTestId(`product-tour-${s}`);
    await figure.scrollIntoViewIfNeeded();
    // The visible <img> has finished loading with real pixels.
    await expect
      .poll(() => figure.locator('img:visible').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
  }
  return fetched.sort();
}

test('the landing shows three described product screenshots', async ({ page }) => {
  await page.goto('/');
  const tour = page.getByTestId('landing-product-tour');
  await expect(tour.getByRole('heading', { level: 2 })).toHaveText('See it before you sign up');
  for (const s of SCREENS) {
    const img = page.getByTestId(`product-tour-${s}`).locator('img:visible');
    await expect(img).toHaveCount(1);
    // Real alt text, not a file name — and space reserved before the file arrives.
    expect((await img.getAttribute('alt'))!.length).toBeGreaterThan(40);
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('width', /^\d+$/);
    await expect(img).toHaveAttribute('height', /^\d+$/);
  }
});

test('the alt text follows the page language', async ({ page }) => {
  await page.goto('/de');
  const alt = await page.getByTestId('product-tour-mentor').locator('img:visible').getAttribute('alt');
  expect(alt).toContain('Mentor-Board');
});

test('a light desktop visitor downloads the light desktop captures only', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'theme', value: 'light', url: baseURL! }]);
  expect(await loadTour(page)).toEqual(SCREENS.map((s) => `${s}-desktop-light.webp`).sort());
});

test.describe('dark mode on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('downloads the dark phone captures only', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
    expect(await loadTour(page)).toEqual(SCREENS.map((s) => `${s}-phone-dark.webp`).sort());
  });
});

test('a marketing host gets no tour — the screenshots are of the internship product', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de' });
  await page.goto('/');
  await expect(page.getByText('Every lead, every conversation', { exact: false })).toBeVisible();
  await expect(page.getByTestId('landing-product-tour')).toHaveCount(0);
});
