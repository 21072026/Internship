import { test, expect, type Page } from '@playwright/test';

// The landing's product tour (#1399): three real screenshots, each in the
// visitor's theme and for their device. Not a pixel comparison (house rule) —
// it asserts what the visitor is served: three described images, and only the
// files that match their theme and screen are downloaded — stills and, on a
// desktop, the clips that play over them (TourClip).

const SCREENS = ['mentee', 'mentor', 'company'] as const;

/** Scroll every figure into view (the images are lazy) and return the screenshot files fetched. */
async function loadTour(page: Page, kind: 'webp' | 'clip' = 'webp') {
  const fetched: string[] = [];
  const wanted = kind === 'webp' ? /\.webp$/ : /\.(webm|mp4)$/;
  page.on('response', (r) => {
    // A video answers 206 (a range request) as well as 200.
    if (r.url().includes('/screenshots/') && wanted.test(new URL(r.url()).pathname)) {
      expect([200, 206], r.url()).toContain(r.status());
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
    if (kind === 'clip') await page.waitForTimeout(800);
  }
  // Deduplicated: a video may be fetched in several ranges.
  return [...new Set(fetched)].sort();
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

// The screens themselves are in the page language too (#2808): a German visitor
// downloads the German captures and clips, not the English ones.
for (const locale of ['tr', 'de'] as const) {
  test(`a ${locale.toUpperCase()} visitor gets the ${locale.toUpperCase()} captures and clips`, async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'theme', value: 'light', url: baseURL! }]);
    const fetched: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/screenshots/')) fetched.push(new URL(r.url()).pathname.split('/').pop()!);
    });
    await page.goto(`/${locale}`);
    for (const s of SCREENS) {
      const figure = page.getByTestId(`product-tour-${s}`);
      await figure.scrollIntoViewIfNeeded();
      await expect
        .poll(() => figure.locator('img:visible').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      await page.waitForTimeout(800);
    }
    const files = [...new Set(fetched)].sort();
    expect(files.filter((f) => f.endsWith('.webp'))).toEqual(SCREENS.map((s) => `${s}-desktop-light-${locale}.webp`).sort());
    expect(files.filter((f) => f.endsWith('.webm'))).toEqual(SCREENS.map((s) => `${s}-desktop-light-${locale}.webm`).sort());
  });
}

test('a light desktop visitor downloads the light desktop captures only', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'theme', value: 'light', url: baseURL! }]);
  expect(await loadTour(page)).toEqual(SCREENS.map((s) => `${s}-desktop-light.webp`).sort());
});

test('every capture of a device has one size, so the three frames match', async ({ page }) => {
  await page.goto('/');
  const sizes = await page.getByTestId('landing-product-tour').locator('img:visible').evaluateAll((imgs) =>
    imgs.map((i) => `${i.getAttribute('width')}x${i.getAttribute('height')}`),
  );
  expect(sizes).toHaveLength(3);
  expect(new Set(sizes).size).toBe(1);
});

test('a dark desktop visitor plays the dark clips only, as WebM', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
  expect(await loadTour(page, 'clip')).toEqual(SCREENS.map((s) => `${s}-desktop-dark.webm`).sort());
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('keeps the stills and fetches no clip', async ({ page }) => {
    expect(await loadTour(page, 'clip')).toEqual([]);
  });
});

test.describe('dark mode on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('downloads the dark phone captures only', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
    expect(await loadTour(page)).toEqual(SCREENS.map((s) => `${s}-phone-dark.webp`).sort());
  });

  test('plays no clip — a phone keeps the still', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
    expect(await loadTour(page, 'clip')).toEqual([]);
  });
});

test('a marketing host gets its own tour — SaleVali screens, never the internship ones', async ({ page }) => {
  const fetched: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/screenshots/')) fetched.push(new URL(r.url()).pathname.split('/').pop()!);
  });
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de' });
  await page.goto('/');
  await expect(page.getByText('Every lead, every conversation', { exact: false })).toBeVisible();
  const tour = page.getByTestId('landing-product-tour');
  await expect(tour.getByRole('heading', { level: 2 })).toHaveText('See it in action');
  for (const s of ['mkt-pipeline', 'mkt-rep', 'mkt-insights']) {
    const figure = page.getByTestId(`product-tour-${s}`);
    await figure.scrollIntoViewIfNeeded();
    await expect
      .poll(() => figure.locator('img:visible').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
  }
  for (const s of SCREENS) await expect(page.getByTestId(`product-tour-${s}`)).toHaveCount(0);
  expect(fetched.length).toBeGreaterThan(0);
  for (const f of fetched) expect(f, 'a marketing visitor only downloads marketing captures').toMatch(/^mkt-/);
});
