import { test, expect } from '@playwright/test';

// The pre-launch checklist items the 2026-10 site audit found missing, on both
// products (interncrm.com and the marketing host, forged through
// x-forwarded-host exactly as host-vertical-landing.spec.ts does):
//
//  - /llms.txt exists and lists only the pages that host serves;
//  - every page carries a canonical URL (and og:url) without the query string;
//  - the marketing landing has an FAQ of its own, with FAQPage JSON-LD;
//  - /ai has its own title instead of the home page's.
//
// Anonymous by design — a crawler or an agent has no cookies.
test.use({ storageState: { cookies: [], origins: [] } });

const MARKETING = { 'x-forwarded-host': 'marketing.bcsit-gmbh.de' };

test('llms.txt describes the internship product and its public pages', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/markdown');
  const body = await res.text();
  expect(body.startsWith('# Internship CRM\n')).toBe(true);
  expect(body).toContain('/privacy)');
  expect(body).toContain('/apply-as-mentor)');
});

test('llms.txt on the marketing host lists only marketing pages', async ({ request }) => {
  const res = await request.get('/llms.txt', { headers: MARKETING });
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body.startsWith('# SaleVali\n')).toBe(true);
  expect(body).toContain('://marketing.bcsit-gmbh.de/privacy)');
  // Internship-only pages 404 on this host; the map must not send an agent there.
  expect(body).not.toContain('/apply-as-mentor');
  expect(body).not.toContain('/for-companies');
  expect(body).not.toContain('interncrm');
});

test('the canonical URL drops the query string', async ({ page }) => {
  await page.goto('/privacy?utm_source=newsletter');
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(new URL(canonical!).pathname).toBe('/privacy');
  expect(new URL(canonical!).search).toBe('');
  expect(await page.locator('meta[property="og:url"]').getAttribute('content')).toBe(canonical);
});

test('the canonical URL follows the marketing host', async ({ page }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/trust?ref=x');
  const canonical = new URL((await page.locator('link[rel="canonical"]').getAttribute('href'))!);
  expect(canonical.host).toBe('marketing.bcsit-gmbh.de');
  expect(canonical.pathname + canonical.search).toBe('/trust');
});

test('the marketing landing has its own FAQ', async ({ page }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/');
  const faq = page.getByTestId('landing-faq');
  await expect(faq.getByText('What exactly is SaleVali?')).toBeVisible();
  // None of the internship per-role questions leak onto this host.
  await expect(faq.locator('details')).toHaveCount(6);
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.some((s) => s.includes('"FAQPage"') && s.includes('What exactly is SaleVali?'))).toBe(true);
});

test('/ai names itself in the tab', async ({ page }) => {
  await page.goto('/ai');
  await expect(page).toHaveTitle(/^How we use AI · /);
});
