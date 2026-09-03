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
