import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { seedUser, uniqueEmail, cleanupByEmail, prisma } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The affiliate module does not exist on the INTERNSHIP product (Story #3111):
 * no page and no API of it answers there — not to an internship ADMIN, and not to
 * an AFFILIATE account that somehow lives in the internship world.
 *
 * The routes are read from the file system, not listed by hand, so a page or an
 * API added to the module later is covered without anyone remembering this file.
 * @smoke: a product boundary.
 */

const PW = 'AffIntern123!';
const ROOT = path.join(__dirname, '..', 'src', 'app');
const DUMMY_ID = 'does-not-matter';
let adminEmail = '';
let strayEmail = '';
let marketingEmail = '';
let marketingOrgId = '';
const contexts: APIRequestContext[] = [];

/** Every file named `name` under `dir`, as its URL path ([param] → a dummy id). */
function routesUnder(dir: string, name: 'route.ts' | 'page.tsx'): { url: string; file: string }[] {
  const out: { url: string; file: string }[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) {
        const url = '/' + path.relative(ROOT, path.dirname(full)).split(path.sep).map((s) => (s.startsWith('[') ? DUMMY_ID : s)).join('/');
        out.push({ url, file: full });
      }
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

const API_ROUTES = [...routesUnder('api/admin/affiliate', 'route.ts'), ...routesUnder('api/affiliate', 'route.ts')].map((r) => ({
  url: r.url,
  methods: [...fs.readFileSync(r.file, 'utf8').matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]),
}));
const PAGES = [...routesUnder('admin/affiliates', 'page.tsx'), ...routesUnder('affiliate', 'page.tsx')].map((r) => r.url);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  adminEmail = uniqueEmail('aff-intern-admin');
  strayEmail = uniqueEmail('aff-intern-stray');
  // No org: the default organisation, i.e. the internship product.
  await seedUser(adminEmail, PW, 'ADMIN', 'Internship Admin');
  await seedUser(strayEmail, PW, 'AFFILIATE', 'Internship Affiliate');
  marketingOrgId = (await prisma.organization.create({ data: { name: `Acme Sales ${Date.now()}`, slug: `aff-intern-m-${Date.now()}`, vertical: 'MARKETING' } })).id;
  marketingEmail = uniqueEmail('aff-intern-marketing');
  await seedUser(marketingEmail, PW, 'ADMIN', 'Marketing Admin', { orgId: marketingOrgId });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const e of [adminEmail, strayEmail, marketingEmail]) if (e) await cleanupByEmail(e);
  if (marketingOrgId) await prisma.organization.deleteMany({ where: { id: marketingOrgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the route list is real (a moved folder would make the sweep vacuous)', { tag: '@smoke' }, () => {
  expect(API_ROUTES.length).toBeGreaterThanOrEqual(18);
  expect(API_ROUTES.every((r) => r.methods.length > 0)).toBe(true);
  expect(PAGES.length).toBeGreaterThanOrEqual(14);
});

for (const who of ['admin', 'stray'] as const) {
  test(`no affiliate API or page answers an internship ${who === 'admin' ? 'ADMIN' : 'AFFILIATE'}`, { tag: '@smoke' }, async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    contexts.push(ctx);
    // The internship host: no forged marketing host header.
    expect((await signInViaApi(ctx, who === 'admin' ? adminEmail : strayEmail, PW)).ok).toBe(true);

    for (const route of API_ROUTES) {
      for (const method of route.methods) {
        const res = await ctx.fetch(route.url, { method, data: method === 'GET' || method === 'DELETE' ? undefined : {} });
        expect([403, 404], `${method} ${route.url} → ${res.status()}`).toContain(res.status());
      }
    }

    for (const url of PAGES) {
      const res = await ctx.get(url);
      const status = res.status();
      // Not served: a 404, or a redirect away from the module (the partner shell
      // sends a non-partner home). Never the page itself. Under /admin a
      // `loading.tsx` streams the response, so the status line is already 200
      // when the layout's notFound() runs: the 404 is then the body's own marker.
      const location = res.headers()['location'] ?? '';
      const away = status >= 300 && status < 400 && !location.includes('/affiliate');
      const notFoundBody = status === 200 && (await res.text()).includes('NEXT_HTTP_ERROR_FALLBACK;404');
      expect(status === 404 || away || notFoundBody, `${url} → ${status} ${location}`).toBe(true);
    }
  });
}

test('control: the same admin pages ARE served on the marketing product', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  // Without this, a check that the internship body carries the 404 marker could
  // pass for a page that never renders anywhere.
  const ctx = await playwright.request.newContext({ baseURL, maxRedirects: 0, extraHTTPHeaders: asHost(MARKETING_HOST) });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, marketingEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  for (const url of PAGES.filter((u) => u.startsWith('/admin/'))) {
    const res = await ctx.get(url);
    expect(res.status(), url).toBe(200);
    expect(await res.text(), url).not.toContain('NEXT_HTTP_ERROR_FALLBACK;404');
  }
});
