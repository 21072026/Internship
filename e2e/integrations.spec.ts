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
    const { webhook, secret } = await wh.json();
    expect(secret).toBeTruthy();

    // Editing the URL and the event set keeps the signing secret — the receiver
    // has already deployed verification code against it (#2000).
    const edited = await page.request.patch(`/api/admin/webhooks?id=${webhook.id}`, {
      data: { url: 'https://example.org/hook2', events: ['pipeline.stage_change'] },
    });
    expect(edited.ok()).toBeTruthy();
    const afterEdit = await prisma.webhook.findUnique({ where: { id: webhook.id } });
    expect(afterEdit!.url).toBe('https://example.org/hook2');
    expect(afterEdit!.secret).toBe(secret);

    // Pausing writes active = false, which is the only filter dispatchWebhook
    // applies — a paused hook is therefore delivered nothing.
    const paused = await page.request.patch(`/api/admin/webhooks?id=${webhook.id}`, { data: { active: false } });
    expect(paused.ok()).toBeTruthy();
    expect((await prisma.webhook.findUnique({ where: { id: webhook.id } }))!.active).toBe(false);
    const listed = await page.request.get('/api/admin/webhooks');
    expect((await listed.json()).webhooks.find((w: { id: string }) => w.id === webhook.id).active).toBe(false);

    // An edited URL hits the same SSRF guard as a created one.
    const blocked = await page.request.patch(`/api/admin/webhooks?id=${webhook.id}`, { data: { url: 'https://127.0.0.1/hook' } });
    expect(blocked.status()).toBe(400);
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: 'CI key' } });
    await prisma.webhook.deleteMany({ where: { url: { in: ['https://example.com/hook', 'https://example.org/hook2'] } } });
    await cleanupByEmail(adminEmail);
  }
});
