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
    // A key must carry at least one scope since #1545.
    const created = await page.request.post('/api/admin/api-keys', { data: { name: 'CI key', scopes: ['candidates:read'] } });
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
