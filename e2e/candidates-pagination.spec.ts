import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC H (#421): the candidates API paginates server-side and reports a total,
// with all=1 as the escape hatch used by CSV/Excel export.
test('candidates API paginates and supports all=1 for export', async ({ page }) => {
  const emails = [uniqueEmail('pg1'), uniqueEmail('pg2'), uniqueEmail('pg3')];
  for (const [i, e] of emails.entries()) await seedUser(e, 'Pass1234!', 'MENTEE', `Pager ${i}`);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Page 1 with pageSize=2 returns exactly 2, and total counts everything.
    const p1 = await (await page.request.get('/api/candidates?pageSize=2&page=1')).json();
    expect(p1.candidates.length).toBe(2);
    expect(typeof p1.total).toBe('number');
    expect(p1.total).toBeGreaterThanOrEqual(3);

    // Page 2 returns different rows (no overlap with page 1).
    const p2 = await (await page.request.get('/api/candidates?pageSize=2&page=2')).json();
    expect(p2.candidates.length).toBeGreaterThanOrEqual(1);
    const p1ids = new Set(p1.candidates.map((c: { id: string }) => c.id));
    expect(p2.candidates.every((c: { id: string }) => !p1ids.has(c.id))).toBe(true);

    // all=1 ignores pagination (used by export) → returns at least our 3 seeds.
    const all = await (await page.request.get('/api/candidates?all=1')).json();
    expect(all.candidates.length).toBeGreaterThanOrEqual(3);
  } finally {
    for (const e of emails) await cleanupByEmail(e);
  }
});
