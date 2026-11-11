import { test, expect, type Page } from '@playwright/test';
import { prisma } from './helpers/db';
import { slotOf, SLOT_MS } from '../src/lib/statusRule';

/**
 * /status (#1604) — public, anonymous, EN/TR/DE, and it must never leak what
 * the HEALTH_TOKEN gate on /api/health keeps private (#897): no version, no
 * git sha, no host or port. @smoke because that last part is a security
 * boundary, not copy.
 *
 * The rows come from StatusSample. This spec writes the current and previous
 * slot itself (the scheduler does not run in the e2e server) and removes them
 * afterwards; `upsert` keeps it harmless if a sampler did run.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function setLocale(page: Page, locale: 'tr' | 'de') {
  await page.goto('/auth/signin');
  await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
}

const now = new Date();
const slots = [slotOf(now), new Date(slotOf(now).getTime() - SLOT_MS)];

test.describe('status page', { tag: '@smoke' }, () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    for (const at of slots) {
      await prisma.statusSample.upsert({ where: { at }, create: { at, mail: 'ok', jobs: 'ok' }, update: { mail: 'ok', jobs: 'ok' } });
    }
  });
  test.afterAll(async () => {
    await prisma.statusSample.deleteMany({ where: { at: { in: slots } } });
  });

  test('renders for a signed-out visitor from the samples, with no build identity on it', async ({ page }) => {
    const res = await page.goto('/status');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('System status');
    await expect(page.getByTestId('status-overall')).toHaveAttribute('data-state', 'operational');
    for (const key of ['web', 'mail', 'jobs']) {
      await expect(page.getByTestId(`status-component-${key}`)).toHaveAttribute('data-state', 'operational');
    }
    // No commitment is published unless the operator set one.
    await expect(page.getByTestId('status-sla')).toContainText('has not published an uptime commitment');

    const text = await page.getByTestId('status-page').innerText();
    expect(text).not.toMatch(/\b\d+\.\d+\.\d+(-[a-z]+)?\b/); // a version
    expect(text).not.toMatch(/\b[0-9a-f]{7,40}\b/); // a sha
    expect(text).not.toMatch(/localhost|127\.0\.0\.1|:\d{4}\b/); // a host or port
  });

  for (const [locale, heading] of [['tr', 'Sistem durumu'], ['de', 'Systemstatus']] as const) {
    test(`renders in ${locale}`, async ({ page }) => {
      await setLocale(page, locale);
      await page.goto('/status');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    });
  }

  test('is linked from the public footer', async ({ page }) => {
    await page.goto('/trust');
    await expect(page.getByTestId('public-footer').locator('a[href$="/status"]')).toHaveCount(1);
  });
});
