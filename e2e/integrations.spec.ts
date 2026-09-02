import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin generates an API key that authorizes the read-only v1 API', async ({ page }) => {
  const adminEmail = uniqueEmail('int-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Int Admin');
  let keyId = '';
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Generate a key (raw value returned once).
    const created = await page.request.post('/api/admin/api-keys', { data: { name: 'CI key' } });
    expect(created.status()).toBe(201);
    const { id, key } = await created.json();
    keyId = id;
    expect(key).toMatch(/^icrm_/);

    // v1 API rejects without a key…
    const anon = await page.request.get('/api/v1/candidates', { headers: { authorization: '' } });
    expect(anon.status()).toBe(401);
    // …and accepts the Bearer key.
    const ok = await page.request.get('/api/v1/candidates', { headers: { authorization: `Bearer ${key}` } });
    expect(ok.ok()).toBeTruthy();
    expect(Array.isArray((await ok.json()).candidates)).toBeTruthy();

    // A webhook can be created and returns its signing secret once.
    const wh = await page.request.post('/api/admin/webhooks', { data: { url: 'https://example.com/hook', events: ['application.created'] } });
    expect(wh.status()).toBe(201);
    expect((await wh.json()).secret).toBeTruthy();
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: 'CI key' } });
    await prisma.webhook.deleteMany({ where: { url: 'https://example.com/hook' } });
    await cleanupByEmail(adminEmail);
  }
});

// #2008 — the connector health board. Untagged on purpose: the board is a
// read-only admin surface, not a critical path, so it stays out of the @smoke
// PR gate and runs in the full suite.
test('admin sees the integration health board', async ({ page }) => {
  const adminEmail = uniqueEmail('health-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Health Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/integrations');
    const board = page.getByTestId('integration-health');
    await expect(board).toBeVisible();
    await expect(page.getByTestId('health-row-email')).toBeVisible();
    await expect(page.getByTestId('health-row-webhooks')).toBeVisible();
    await expect(page.getByTestId('health-row-sso')).toBeVisible();

    // No tenant has SSO switched on in CI, so the row must read "not
    // configured" — never "failing" (acceptance criterion).
    await expect(page.getByTestId('health-state-sso')).toHaveText('Not configured');

    // Nothing on the board may carry an address: every connector's error text
    // goes through lib/sanitizeError before it is rendered.
    expect(await board.innerText()).not.toContain('@');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('a non-admin is refused the integration health route', async ({ page }) => {
  const mentorEmail = uniqueEmail('health-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Health Mentor');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.get('/api/admin/integrations/health');
    expect([401, 403]).toContain(res.status());
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
