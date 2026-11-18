import { test, expect, type Page } from '@playwright/test';
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from '@/lib/cookieConsent';
import { freshIp } from './helpers/rateLimit';

type Captured = { name: string; options: { props: object } };
async function recorder(page: Page, consent: boolean, loaded = true) {
  const events: Captured[] = [];
  await page.setExtraHTTPHeaders(freshIp('analytics-conversions'));
  await page.route('**/__analytics-test-collect', route => route.fulfill({ status: 204 }));
  page.on('request', request => {
    if (request.url().endsWith('/__analytics-test-collect')) events.push(request.postDataJSON() as Captured);
  });
  await page.addInitScript(({ key, version, consent, loaded }) => {
    localStorage.setItem(key, JSON.stringify({ version, necessary: true, analytics: consent, marketing: false, ts: new Date().toISOString() }));
    if (loaded) {
      const w = window as unknown as { plausible: (name: string, options: object) => void };
      w.plausible = (name, options) => { void fetch('/__analytics-test-collect', { method: 'POST', body: JSON.stringify({ name, options }), keepalive: true }); };
    }
  }, { key: COOKIE_CONSENT_KEY, version: COOKIE_CONSENT_VERSION, consent, loaded });
  return events;
}

test('without consent no conversion event or analytics network request leaves a loaded provider', { tag: '@smoke' }, async ({ page }) => {
  const events = await recorder(page, false);
  const vendorRequests: string[] = [];
  page.on('request', request => { if (/plausible|google-analytics|posthog|__analytics-test-collect/.test(request.url())) vendorRequests.push(request.url()); });
  await page.goto('/features');
  await expect(page.locator('main')).toBeVisible();
  await page.goto('/');
  // Keep the browser here while exercising real click handlers.
  await page.evaluate(() => document.addEventListener('click', e => { if ((e.target as Element).closest('a')) e.preventDefault(); }, true));
  await page.getByTestId('role-card').first().getByRole('link').click();
  await page.getByTestId('hero-demo-cta').click();
  expect(events).toEqual([]);
  expect(vendorRequests).toEqual([]);
});

test('unconfigured providers produce no scripts, collector traffic or console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const events = await recorder(page, true, false);
  await page.goto('/features');
  await page.goto('/pricing');
  await expect(page.locator('script[data-analytics]')).toHaveCount(0);
  expect(events).toEqual([]);
  expect(errors).toEqual([]);
});

test('features/pricing views and role/demo clicks use stable names and finite properties', async ({ page }) => {
  const events = await recorder(page, true);
  await page.goto('/features');
  await expect.poll(() => events.map(e => e.name)).toEqual(['features_viewed']);
  await page.goto('/pricing');
  await expect.poll(() => events.map(e => e.name)).toEqual(['features_viewed', 'pricing_viewed']);
  await page.goto('/');
  await page.evaluate(() => document.addEventListener('click', e => { if ((e.target as Element).closest('a')) e.preventDefault(); }, true));
  await page.getByTestId('role-card').nth(1).getByRole('link').click();
  await page.getByTestId('hero-demo-cta').click();
  await expect.poll(() => events.slice(2)).toEqual([
    { name: 'role_card_selected', options: { props: { role: 'mentor' } } },
    { name: 'demo_cta_click', options: { props: { placement: 'hero' } } },
  ]);
  await page.evaluate(key => {
    const value = JSON.parse(localStorage.getItem(key)!); value.analytics = false;
    localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new Event('cookieconsentchange'));
  }, COOKIE_CONSENT_KEY);
  await page.getByTestId('hero-demo-cta').click();
  expect(events).toHaveLength(4);
});

test('a page view waits for SDK readiness and only sends once', async ({ page }) => {
  const events = await recorder(page, true, false);
  await page.goto('/features');
  await expect(page.locator('main')).toBeVisible();
  expect(events).toEqual([]);
  await page.evaluate(() => {
    (window as unknown as { plausible: (name: string, options: object) => void }).plausible = (name, options) => {
      void fetch('/__analytics-test-collect', { method: 'POST', body: JSON.stringify({ name, options }) });
    };
    window.dispatchEvent(new Event('analyticsproviderready'));
    window.dispatchEvent(new Event('analyticsproviderready'));
  });
  await expect.poll(() => events.map(e => e.name)).toEqual(['features_viewed']);
});

for (const form of ['signup', 'mentor', 'company'] as const) {
  test(`${form} conversion fires only after successful server response and contains no form PII`, async ({ page }) => {
    const events = await recorder(page, true);
    const endpoint = form === 'signup' ? '/api/register' : form === 'mentor' ? '/api/mentor-applications' : '/api/company-inquiry';
    let status = 500;
    let posts = 0;
    await page.route(`**${endpoint}`, route => {
      posts++;
      return route.fulfill({ status, json: status === 200 ? { selfRegistered: true } : { error: 'Synthetic refusal' } });
    });
    await page.goto(form === 'signup' ? '/auth/register' : form === 'mentor' ? '/apply-as-mentor' : '/for-companies');
    const target = form === 'company' ? page.getByTestId('company-inquiry-form') : page.locator('form').filter({ has: page.locator('input[name="fullName"]') });
    if (form === 'company') {
      await target.locator('input').nth(0).fill('Synthetic Company');
      await target.locator('input').nth(1).fill('Test Visitor');
      await target.locator('input[type="email"]').fill('visitor@demo.example.com');
      await target.getByTestId('inquiry-consent').check();
    } else {
      await target.locator('input[name="fullName"]').fill('Test Visitor');
      await target.locator('input[name="email"]').fill('visitor@demo.example.com');
      if (form === 'signup') {
        await target.locator('input[name="password"]').fill('AnalyticsPass123!');
        await target.locator('input[name="confirmPassword"]').fill('AnalyticsPass123!');
      } else {
        await page.getByTestId('mentor-expertise-input').fill('TypeScript');
        await page.getByTestId('mentor-expertise-input').press('Enter');
      }
      await target.locator('input[type="checkbox"]').first().check();
    }
    const button = target.locator('button[type="submit"]');
    await button.click();
    await expect.poll(() => posts).toBe(1);
    await expect(button).toBeEnabled();
    expect(events).toEqual([]);
    status = 200;
    await button.click();
    await expect.poll(() => events.map(e => e.name)).toEqual([form === 'signup' ? 'signup_completed' : form === 'mentor' ? 'mentor_application_submitted' : 'company_inquiry_submitted']);
    expect(events[0].options.props).toEqual({});
    expect(JSON.stringify(events)).not.toMatch(/visitor@|Test Visitor|Synthetic Company|AnalyticsPass/);
  });
}

for (const status of [400, 200]) {
  test(`verification HTTP ${status} ${status === 200 ? 'emits signup_verified once' : 'never emits a conversion'}`, async ({ page }) => {
    const events = await recorder(page, true);
    let posts = 0;
    await page.route('**/api/auth/verify-email', route => { posts++; return route.fulfill({ status, json: { ok: status === 200 } }); });
    await page.goto('/auth/verify?token=synthetic-secret');
    await expect.poll(() => posts).toBe(1);
    if (status === 200) {
      await expect.poll(() => events.map(e => e.name)).toEqual(['signup_verified']);
      await expect(page).toHaveURL(/\/auth\/verify$/);
      expect(JSON.stringify(events)).not.toContain('synthetic-secret');
    } else {
      await expect(page.locator('h1')).toBeVisible();
      expect(events).toEqual([]);
    }
  });
}
