import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('bulk import dry-run validates rows without creating users', async ({ page }) => {
  const adminEmail = uniqueEmail('dr-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'DR Admin');
  const tag = Date.now();
  const goodEmail = `dr-good-${tag}@example.com`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // One valid row, one invalid email, one duplicate of the admin.
    const csv = `fullName,email\nGood One,${goodEmail}\nBad,not-an-email\nDup,${adminEmail}`;
    const res = await page.request.post('/api/admin/import', { data: { csv, dryRun: true } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.dryRun).toBe(true);
    expect(d.willCreate).toBe(1);
    expect(d.errors).toBe(1);
    expect(d.skipped).toBe(1);
    expect(d.rows).toHaveLength(3);

    // Nothing was actually created.
    const created = await prisma.user.findFirst({ where: { email: goodEmail } });
    expect(created).toBeNull();
  } finally {
    await prisma.user.deleteMany({ where: { email: goodEmail } });
    await cleanupByEmail(adminEmail);
  }
});

// #1432: a name longer than its column used to pass the dry run and then kill
// the real run with an empty 500 after the rows before it were written. Now
// the dry run and the real run share one rule set, a bad row is reported, and
// the rest of the file is written.
test('dry run and real run agree; an over-long row is reported, not a 500', async ({ page }) => {
  const adminEmail = uniqueEmail('dr-long-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'DR Long Admin');
  const tag = Date.now();
  const one = `dr-one-${tag}@example.com`;
  const two = `dr-two-${tag}@example.com`;
  const long = `dr-long-${tag}@example.com`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const csv = `\uFEFFfullName,email\nGood One,${one}\n${'N'.repeat(250)},${long}\nGood Two,${two}\nAgain,${one.toUpperCase()}`;
    const dry = await (await page.request.post('/api/admin/import', { data: { csv, dryRun: true } })).json();
    expect(dry).toMatchObject({ willCreate: 2, errors: 1, skipped: 1 });
    expect(dry.rows.map((r: { status: string }) => r.status)).toEqual(['create', 'error', 'create', 'skip']);
    expect(dry.rows[1].reason).toMatch(/fullName too long/);
    expect(dry.rows[3].reason).toBe('duplicate in file');

    const res = await page.request.post('/api/admin/import', { data: { csv } });
    expect(res.status()).toBe(200);
    const real = await res.json();
    expect(real.created).toBe(dry.willCreate);
    expect(real.rows.map((r: { status: string }) => r.status)).toEqual(['create', 'error', 'create', 'skip']);
    const written = await prisma.user.findMany({ where: { email: { in: [one, two, long] } }, select: { email: true } });
    expect(written.map((u) => u.email).sort()).toEqual([one, two].sort());

    // Running the same file again creates nothing new.
    const again = await (await page.request.post('/api/admin/import', { data: { csv } })).json();
    expect(again).toMatchObject({ created: 0, skipped: 3, errors: 1 });

    // A body that is not JSON is a 400, not a crash.
    const junk = await page.request.post('/api/admin/import', { data: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect(junk.status()).toBe(400);
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [one, two, long] } } });
    await cleanupByEmail(adminEmail);
  }
});
