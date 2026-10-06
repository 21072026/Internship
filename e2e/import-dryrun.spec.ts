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

// #2072: the importer runs on the shared engine and the settings screen draws
// its report with the shared <ImportPreview> — the preview and the finished
// run are the same table, differing only in the note above it.
test('the settings importer previews on the shared engine, then writes exactly what it previewed', async ({ page }) => {
  const adminEmail = uniqueEmail('ip-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IP Admin');
  const tag = Date.now();
  const good = `ip-good-${tag}@example.com`;
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // A German Excel export: `;` as the delimiter and a quoted name — the
    // hand-rolled splitter this replaces read it as one column.
    const csv = `email;fullName\n${good};"Good; One"\nnot-an-email;Bad`;
    const dry = await (await page.request.post('/api/admin/import', { data: { csv, dryRun: true } })).json();
    expect(dry).toMatchObject({ willCreate: 1, errors: 1, report: { dryRun: true, counts: { CREATE: 1, ERROR: 1 } } });
    expect(dry.report.rows.map((r: { status: string }) => r.status)).toEqual(['CREATE', 'ERROR']);

    await page.goto('/admin/settings');
    await page.getByTestId('import-csv').fill(csv);
    await page.getByTestId('import-dry-run').click();
    const preview = page.getByTestId('import-preview');
    await expect(preview).toHaveAttribute('data-dry-run', 'true');
    await expect(preview.getByTestId('import-preview-counts').locator('[data-status="CREATE"]')).toHaveAttribute('data-count', '1');
    await expect(preview.getByTestId('import-preview-row-2')).toHaveAttribute('data-status', 'ERROR');
    await expect(preview.getByTestId('import-preview-row-2')).toContainText('Not a valid e-mail address');
    expect(await prisma.user.findFirst({ where: { email: good } })).toBeNull();

    await page.getByTestId('import-run').click();
    await expect(page.getByTestId('import-preview')).toHaveAttribute('data-dry-run', 'false');
    await expect(page.getByTestId('import-preview-row-1')).toHaveAttribute('data-status', 'CREATE');
    const written = await prisma.user.findFirst({ where: { email: good } });
    expect(written).toMatchObject({ fullName: 'Good; One', role: 'MENTEE' });
  } finally {
    await prisma.user.deleteMany({ where: { email: good } });
    await cleanupByEmail(adminEmail);
  }
});
