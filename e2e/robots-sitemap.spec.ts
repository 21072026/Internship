import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * #1380 — /robots.txt and /sitemap.xml exist and say the right things.
 *
 * Both were 404 before this: nothing told a crawler what to fetch, and the
 * public pages that are only linked from the footer were discoverable by luck.
 * The regression these guard against is (a) either route disappearing again,
 * and (b) an authenticated area leaking into the sitemap, which is how a login
 * redirect ends up as a search result.
 *
 * Anonymous by design — a crawler has no cookies.
 *
 * The rules differ by deployment: production is crawlable, while preview, the
 * per-PR topic envs and the demo close the site so the same content is not
 * indexed three times over. Which one is under test is read from the response
 * rather than assumed, so the spec is equally valid locally (production
 * defaults) and against a deployed BASE_URL.
 */
test.use({ storageState: { cookies: [], origins: [] } });

// Path prefixes that must never appear in the sitemap. `/mentors` (the
// signed-in mentor directory, #938) is listed explicitly rather than relying
// on the `/mentor` prefix to catch it, so removing `/mentor` later can't
// silently stop covering it.
const PRIVATE_PREFIXES = [
  '/admin',
  '/mentor',
  '/mentors',
  '/portal',
  '/company',
  '/messages',
  '/account',
  '/notifications',
  '/todos',
  '/onboarding',
  '/interviews',
  '/weekly-reports',
  '/newsletter',
  '/newsletters',
  '/testimonials',
  '/re-engage',
  '/consent',
  '/security-setup',
  '/source',
  '/offline',
  '/rsvp',
  '/m',
  '/u',
  '/api',
  '/auth',
  // Public profiles are a share link the person turned on, not an index entry
  // (a separate consent question — see sitemap.ts).
  '/p',
];

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The `<loc>` values of a sitemap, as pathnames. */
function locPathnames(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1].trim()).pathname);
}

function contentType(res: APIResponse): string {
  return res.headers()['content-type'] ?? '';
}

async function robotsText(request: APIRequestContext): Promise<string> {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  return res.text();
}

/** True when this deployment closes the whole site (preview / topic / demo). */
function isClosed(body: string): boolean {
  return /^Disallow:\s*\/$/m.test(body);
}

test('robots.txt is served', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  expect(contentType(res)).toContain('text/plain');
  expect(await res.text()).toContain('User-Agent: *');
});

test('a crawlable deployment links the sitemap and fences off the app', { tag: '@smoke' }, async ({ request }) => {
  const body = await robotsText(request);
  test.skip(isClosed(body), 'this deployment is non-production and closed to crawlers entirely');

  expect(body).toContain('Allow: /');
  // An absolute URL, as the format requires — the host depends on the env.
  const sitemapLine = body.match(/^Sitemap:\s*(\S+)$/m);
  expect(sitemapLine, `no Sitemap: line in\n${body}`).not.toBeNull();
  expect(new URL(sitemapLine![1]).pathname).toBe('/sitemap.xml');

  for (const p of ['/admin', '/portal', '/messages', '/api/', '/auth/']) {
    expect(body, `expected ${p} to be disallowed`).toContain(`Disallow: ${p}`);
  }
  // The public mentor directory must not be collateral damage of /mentor.
  expect(body).not.toMatch(/^Disallow:\s*\/mentor$/m);
});

test('a preview or demo deployment is closed to crawlers', async ({ request }) => {
  const body = await robotsText(request);
  test.skip(!isClosed(body), 'this deployment is production and meant to be crawled');

  expect(body).not.toContain('Allow: /');
  // A blanket disallow with a sitemap next to it contradicts itself.
  expect(body).not.toMatch(/^Sitemap:/m);
});

test('sitemap.xml lists the public pages and nothing behind a login', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  expect(contentType(res)).toContain('xml');

  const xml = await res.text();
  expect(xml).toContain('<urlset');
  expect(xml.trimEnd()).toMatch(/<\/urlset>$/);

  const paths = locPathnames(xml);
  // The landing plus the pages that are otherwise footer-only.
  expect(paths).toContain('/');
  for (const p of ['/features', '/for-companies', '/privacy', '/terms', '/imprint']) {
    expect(paths).toContain(p);
  }

  for (const path of paths) {
    for (const prefix of PRIVATE_PREFIXES) {
      expect(isUnder(path, prefix), `sitemap lists ${path}, which is under ${prefix}`).toBe(false);
    }
  }
});

test('sitemap entries all resolve for an anonymous visitor', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  // Cap the walk: the dynamic project entries grow with the database and this
  // spec is about the shape of the list, not a full crawl.
  for (const path of locPathnames(xml).slice(0, 20)) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), `${path} is in the sitemap but answers ${res.status()}`).toBe(200);
  }
});
