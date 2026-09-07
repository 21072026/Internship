import { test, expect } from '@playwright/test';

// The landing page must offer a path to the public demo (#966): a hero button,
// an inline link in the bottom CTA block, and a footer link. All three point at
// the demo host and are hidden on the demo instance itself (IS_DEMO_MODE) —
// these tests run against non-demo envs, so they assert presence.
const DEMO_HOST = 'demo.interncrm.com';

// The UTM scheme every demo link carries (#1391), from src/lib/demoMode.ts.
// One campaign, one medium, one source — `utm_content` is what tells the report
// which control the visitor actually used.
const SHARED_UTM = { utm_source: 'crm', utm_medium: 'cta', utm_campaign: 'demo' };

function assertDemoLink(href: string | null, expectedContent: string) {
  expect(href).toBeTruthy();
  const url = new URL(href!);
  expect(url.host).toBe(DEMO_HOST);
  expect(url.protocol).toBe('https:');
  for (const [k, v] of Object.entries(SHARED_UTM)) {
    expect(url.searchParams.get(k)).toBe(v);
  }
  expect(url.searchParams.get('utm_content')).toBe(expectedContent);
}

test('the landing page links to the live demo (hero, CTA block, footer)', async ({ page }) => {
  await page.goto('/');

  const hero = page.getByTestId('hero-demo-cta');
  await expect(hero).toBeVisible();
  await expect(hero).toContainText('Try the live demo');
  assertDemoLink(await hero.getAttribute('href'), 'hero');

  const inline = page.getByTestId('cta-demo-link');
  assertDemoLink(await inline.getAttribute('href'), 'cta');

  // Footer link (labelled via publicNav.demo). Matched on the host rather than
  // the full URL so the assertion does not restate the query string.
  const footerLink = page.locator(`footer a[href*="${DEMO_HOST}"]`);
  await expect(footerLink).toBeVisible();
  assertDemoLink(await footerLink.getAttribute('href'), 'footer');
  // An outbound link opened in a new tab must not hand the opener over (#1391).
  await expect(footerLink).toHaveAttribute('rel', /noopener/);
  await expect(footerLink).toHaveAttribute('rel', /noreferrer/);
});

// Every demo link shares one campaign and differs only in utm_content — that is
// the whole point: the report can total the demo traffic and still say which of
// the three controls earned it.
test('the demo links are distinguishable by utm_content', async ({ page }) => {
  await page.goto('/');

  const contents = await page.evaluate((host) =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href*="${host}"]`)).map(
      (a) => new URL(a.href).searchParams.get('utm_content'),
    ),
  DEMO_HOST);

  expect(contents.length).toBeGreaterThanOrEqual(3);
  // No untagged link, and no two links sharing a tag.
  expect(contents.every((c) => !!c)).toBe(true);
  expect(new Set(contents).size).toBe(contents.length);
});

// The click event is consent-gated (src/lib/track.ts): with no stored analytics
// consent no provider is loaded and the handler must be a silent no-op — the
// navigation still happens and nothing throws.
test('clicking a demo link without analytics consent sends nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  // Nothing may leave for a third party without consent.
  const analyticsRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/plausible|google-analytics|googletagmanager|posthog/.test(u)) analyticsRequests.push(u);
  });

  // Don't actually leave the site: the event fires on click, the navigation is
  // irrelevant to what we assert.
  await page.getByTestId('hero-demo-cta').evaluate((el) => {
    el.addEventListener('click', (e) => e.preventDefault());
    (el as HTMLElement).click();
  });

  expect(errors).toEqual([]);
  expect(analyticsRequests).toEqual([]);
});

test('the demo CTA is localized', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
  await page.reload();
  await expect(page.getByTestId('hero-demo-cta')).toContainText('Canlı demoyu deneyin');
});

// The quick-login panel is a demo-instance feature (#966): the server page
// passes the shared accounts only when DEMO_MODE=true, so on every other env
// (including this test run) the sign-in page must not render it.
test('the demo quick-login panel stays hidden off the demo instance', async ({ page }) => {
  await page.goto('/auth/signin');
  await expect(page.getByRole('heading')).toBeVisible();
  await expect(page.getByTestId('demo-quick-login')).toHaveCount(0);
});
