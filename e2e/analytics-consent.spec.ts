import { test, expect } from '@playwright/test';
import { analyticsCspHosts } from '@/lib/analyticsCsp.cjs';

/**
 * Growth analytics (#1242) — the two objections that held #1221 back.
 *
 * The e2e run configures no provider, which is the shape every real deployment
 * ships in until an operator decides otherwise. So these assert the OFF state,
 * which is the state that has to be safe.
 */

test('with no provider configured, the CSP allows no analytics host', async ({ page }) => {
  // The unit half: the table the config reads is empty without env.
  expect(analyticsCspHosts({})).toEqual({ script: [], connect: [] });

  // The shipped half: the real response header names none of them.
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'] ?? '';
  expect(csp).not.toContain('googletagmanager');
  expect(csp).not.toContain('google-analytics');
  expect(csp).not.toContain('posthog');
  expect(csp).not.toContain('plausible');
});

test('no analytics script is injected without configuration, on any page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('script[data-analytics]')).toHaveCount(0);
  // And the loader is not mounted on the app shell at all — that was the second
  // objection: at the root layout these would have run on signed-in CRM pages.
  await page.goto('/features');
  await expect(page.locator('script[data-analytics]')).toHaveCount(0);
});
