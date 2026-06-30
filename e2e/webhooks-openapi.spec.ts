import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('OpenAPI spec is public and lists the expanded webhook events', async ({ page }) => {
  const res = await page.request.get('/api/v1/openapi.json');
  expect(res.ok()).toBeTruthy();
  const spec = await res.json();
  expect(spec.openapi).toMatch(/^3/);
  expect(spec.paths['/candidates']).toBeTruthy();
  const events = spec['x-webhooks'].events as string[];
  expect(events).toContain('mentorship.created');
  expect(events).toContain('evaluation.added');
  expect(events.length).toBeGreaterThanOrEqual(6);
});

test('admin webhook API exposes the expanded event types', async ({ page }) => {
  const email = uniqueEmail('wh-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'WH Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/webhooks')).json();
    expect(data.eventTypes).toContain('interaction.logged');
    expect(data.eventTypes).toContain('meeting.scheduled');
  } finally {
    await cleanupByEmail(email);
  }
});
