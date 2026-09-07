import { test, expect, type Page } from '@playwright/test';
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from '../src/lib/cookieConsent';

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

// The click event is consent-gated (`src/lib/track.ts`). Proving that needs a
// transport to watch: in CI none of NEXT_PUBLIC_PLAUSIBLE_DOMAIN /
// NEXT_PUBLIC_GA4_MEASUREMENT_ID / NEXT_PUBLIC_POSTHOG_KEY is set, so
// AnalyticsScripts injects nothing, `window.plausible` never exists and
// `track()` no-ops through its optional-call chain whether or not the gate is
// there. Watching outbound *requests* therefore cannot fail — so these two
// tests install a recorder on `window.plausible` before the page loads and
// assert on what `track()` did with it: silence without consent, the event with
// it. Delete the `hasConsent('analytics')` line in track.ts and the first one
// goes red.
//
// The recorder is a get/set pair rather than a plain assignment so it survives
// an environment where a provider *is* configured: the real script's
// `window.plausible = …` lands in `real`, and the getter records and forwards.
async function recordPlausibleCalls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __trackCalls: unknown[][];
      plausible?: (...a: unknown[]) => void;
    };
    w.__trackCalls = [];
    let real: ((...a: unknown[]) => void) | undefined;
    // One stable wrapper, and the setter refuses to store it: the real
    // Plausible snippet assigns `window.plausible = window.plausible || …`,
    // which would otherwise make the wrapper its own `real` and recurse.
    const wrapper = (...args: unknown[]) => {
      w.__trackCalls.push(args);
      real?.(...args);
    };
    Object.defineProperty(w, 'plausible', {
      configurable: true,
      get: () => wrapper,
      set: (fn: (...a: unknown[]) => void) => {
        if (fn !== wrapper) real = fn;
      },
    });
  });
}

// Store an analytics-consent choice before any page script runs. The suite's
// default storageState (e2e/global-setup.ts) is a returning visitor with
// analytics: false, which is exactly the state the first test wants.
async function grantAnalyticsConsent(page: Page) {
  // Key and version read from the app, so bumping COOKIE_CONSENT_VERSION makes
  // this test re-consent instead of silently asserting on a stale choice.
  await page.addInitScript(
    ([key, version]: [string, number]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version,
          necessary: true,
          analytics: true,
          marketing: false,
          ts: new Date().toISOString(),
        }),
      );
    },
    [COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION] as [string, number],
  );
}

// Click the hero CTA without leaving the site: the event fires on click, the
// navigation is irrelevant to what we assert.
async function clickHeroDemoCta(page: Page) {
  await page.getByTestId('hero-demo-cta').evaluate((el) => {
    el.addEventListener('click', (e) => e.preventDefault());
    (el as HTMLElement).click();
  });
}

test('clicking a demo link without analytics consent sends nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Registered before the navigation, or the pageview fired during load is
  // never seen.
  const analyticsRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/plausible|google-analytics|googletagmanager|posthog/.test(u)) analyticsRequests.push(u);
  });

  await recordPlausibleCalls(page);
  await page.goto('/');
  await clickHeroDemoCta(page);

  // The gate, asserted where it lives: a transport was available and track()
  // declined to use it.
  expect(await page.evaluate(() => (window as unknown as { __trackCalls: unknown[][] }).__trackCalls)).toEqual([]);
  // And nothing left for a third party either.
  expect(analyticsRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('clicking a demo link with analytics consent reports the placement', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await recordPlausibleCalls(page);
  await grantAnalyticsConsent(page);
  await page.goto('/');
  await clickHeroDemoCta(page);

  const calls = await page.evaluate(
    () => (window as unknown as { __trackCalls: unknown[][] }).__trackCalls,
  );
  expect(calls).toHaveLength(1);
  const [name, opts] = calls[0] as [string, { props?: Record<string, unknown> }];
  expect(name).toBe('demo_cta_click');
  // The placement, and deliberately nothing else — this is an anonymous page.
  expect(opts?.props).toEqual({ placement: 'hero' });
  expect(errors).toEqual([]);
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
