import { test, expect, type Page } from '@playwright/test';
import { REMEMBER_HINT_COOKIE } from '../src/lib/rememberHint';

// Language URLs for the public site (#1386). English stays unprefixed; Turkish
// and German live under /tr and /de, rewritten by the middleware onto the same
// pages. A language URL is a promise: it opens in its own language whatever
// cookie the reader carries, names itself as canonical, and lists its two
// siblings as hreflang alternates.

const FEATURES_TITLE = {
  en: 'Everything InternshipCRM can do',
  tr: 'InternshipCRM neler yapabilir',
  de: 'Alles, was InternshipCRM kann',
};

async function setLocaleCookie(page: Page, baseURL: string, locale: string) {
  await page.context().addCookies([{ name: 'locale', value: locale, url: baseURL }]);
}

async function head(page: Page) {
  return {
    lang: await page.locator('html').getAttribute('lang'),
    canonical: await page.locator('link[rel="canonical"]').getAttribute('href'),
    alternates: Object.fromEntries(
      await page
        .locator('link[rel="alternate"][hreflang]')
        .evaluateAll((els) => els.map((e) => [e.getAttribute('hreflang'), new URL(e.getAttribute('href')!).pathname]))
    ) as Record<string, string>,
  };
}

test('/tr and /de open in their own language, whatever the cookie says', async ({ page, baseURL }) => {
  // An English cookie: the URL must still win.
  await setLocaleCookie(page, baseURL!, 'en');

  for (const [path, lang] of [['/tr', 'tr'], ['/de', 'de']] as const) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expect(await page.locator('html').getAttribute('lang'), path).toBe(lang);
  }

  await page.goto('/tr/features');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FEATURES_TITLE.tr);
  await page.goto('/de/features');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FEATURES_TITLE.de);

  // The unprefixed URL is unchanged: English content, not a redirect.
  const plain = await page.goto('/features');
  expect(plain?.url()).toMatch(/\/features$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FEATURES_TITLE.en);
});

test('each language URL is canonical to itself and names its siblings', async ({ page }) => {
  await page.goto('/tr/features');
  const tr = await head(page);
  expect(new URL(tr.canonical!).pathname).toBe('/tr/features');
  expect(tr.alternates).toEqual({ en: '/features', tr: '/tr/features', de: '/de/features', 'x-default': '/features' });
  expect(await page.locator('meta[property="og:url"]').getAttribute('content')).toMatch(/\/tr\/features$/);

  await page.goto('/de');
  const de = await head(page);
  expect(new URL(de.canonical!).pathname).toBe('/de');
  expect(de.alternates).toEqual({ en: '/', tr: '/tr', de: '/de', 'x-default': '/' });

  // The public chrome keeps the visitor in the URL's language.
  await page.goto('/tr/features');
  await expect(page.getByTestId('public-home-link')).toHaveAttribute('href', '/tr');
  await expect(page.getByTestId('public-footer').getByRole('link', { name: 'Gizlilik', exact: false }).first()).toHaveAttribute(
    'href',
    /^\/tr\/privacy$/
  );
});

test('the language switcher moves to the same page in the other language', async ({ page }) => {
  await page.goto('/tr/features');
  await page.getByTestId('public-header').getByRole('button', { name: 'de', exact: true }).first().click();
  await expect(page).toHaveURL(/\/de\/features$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FEATURES_TITLE.de);

  // English is unprefixed.
  await page.getByTestId('public-header').getByRole('button', { name: 'en', exact: true }).first().click();
  await expect(page).toHaveURL(/\/features$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FEATURES_TITLE.en);
});

test('only the public site has language URLs', async ({ request }) => {
  // A prefix on the signed-in app is not a page.
  expect((await request.get('/tr/admin', { maxRedirects: 0 })).status()).toBe(404);
  // English has no prefix; a guessed one goes to the real URL.
  const en = await request.get('/en/features', { maxRedirects: 0 });
  expect(en.status()).toBe(308);
  expect(new URL(en.headers()['location'], 'http://x').pathname).toBe('/features');
});

test('a remembered device resumes on a language URL too', async ({ request }) => {
  // No session, a remember hint and a (bogus) device cookie: the middleware
  // sends the request through /auth/resume and keeps the language URL as the
  // destination. Whether the device token is good is /auth/resume's business.
  const res = await request.get('/tr/features', {
    maxRedirects: 0,
    headers: { Cookie: `${REMEMBER_HINT_COOKIE}=1; internship.remember-token=bogus` },
  });
  expect(res.status()).toBe(307);
  const location = new URL(res.headers()['location'], 'http://x');
  expect(location.pathname).toBe('/auth/resume');
  expect(location.searchParams.get('next')).toBe('/tr/features');
});

test('the sitemap lists every public page in all three languages', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  for (const p of ['/features', '/tr/features', '/de/features', '/', '/tr', '/de']) {
    expect(locs, p).toContain(p);
  }
  expect(xml).toContain('hreflang="tr"');
});
