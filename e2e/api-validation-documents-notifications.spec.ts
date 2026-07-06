import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #473: documents/route.ts and notifications/route.ts previously accepted
// malformed bodies with no validation, risking a 500 instead of a 400.
test('POST /api/notifications returns 400 (not 500) for a malformed id', async ({ page }) => {
  const email = uniqueEmail('zod-notif');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Zod Notif Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // id should be a string; an array/object must be rejected with 400.
    const bad = await page.request.post('/api/notifications', { data: { id: ['not', 'a', 'string'] } });
    expect(bad.status()).toBe(400);

    // Valid, id-less body (mark-all-read) still works.
    const ok = await page.request.post('/api/notifications', { data: {} });
    expect(ok.ok()).toBeTruthy();
  } finally {
    await cleanupByEmail(email);
  }
});

test('POST /api/documents returns 400 (not 500) for an invalid document type', async ({ page }) => {
  const email = uniqueEmail('zod-doc');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Zod Doc Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const res = await page.request.post('/api/documents', {
      multipart: { file: { name: 'r.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello') }, type: 'NOT_A_REAL_TYPE' },
    });
    expect(res.status()).toBe(400);

    // A non-multipart body against the same endpoint must not 500 either.
    const malformed = await page.request.post('/api/documents', {
      headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      data: 'not actually multipart',
    });
    expect(malformed.status()).toBe(400);
  } finally {
    await cleanupByEmail(email);
  }
});
