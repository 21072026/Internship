import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { floodIp } from './helpers/rateLimit';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2433: "who read this customer record?" is answered from ActivityLog. Opening
// a company on /admin/companies (the edit dialog, the product's only way in)
// reads GET /api/companies/[id], and that read writes a `company.view` entry.
// A repeat of the same read inside `viewLogWindowMinutes` (default 15) writes
// no second one. The rule, attribution and failure paths included, is
// unit-tested in scripts/test/view-log-rule.test.mjs; this spec pins what only
// a real click can: that the dialog goes through the logged read at all (it
// used to fill itself from the paged list, which logs nothing), with the right
// key, and that the key's origin half is the address logActivity() stores.
//
// The window setting is deliberately NOT changed here: it is a global row, and
// flipping it would change the log for every spec sharing the server.
test('opening a company writes one company.view row per reader, origin and window', async ({ page }) => {
  const adminEmail = uniqueEmail('cva-admin');
  const pw = 'CvaAdminPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'CVA Admin');
  const company = await prisma.company.create({
    data: { name: `CVA Co ${Date.now()}`, industry: 'Synthetic', description: 'Seeded by company-view-access-log' },
  });
  const missingId = `cva-missing-${Date.now()}`;

  const views = () =>
    prisma.activityLog.findMany({
      where: { action: 'company.view', targetId: company.id },
      orderBy: { createdAt: 'asc' },
    });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // Every request the page makes from here on claims one address, so the
    // dialog's reads are "the same read" by origin as well as by reader.
    const here = floodIp('company-view-a');
    await page.setExtraHTTPHeaders(here);

    await gotoSettled(page, '/admin/companies');
    // The grid is paged; search so the seeded company is on the first page.
    await page.getByTestId('companies-search').fill(company.name);
    const editButton = page.getByTestId(`edit-company-${company.id}`);
    await expect(editButton).toBeVisible({ timeout: 15_000 });

    const openDialog = async () => {
      const detailRead = page.waitForResponse(
        (r) => r.url().endsWith(`/api/companies/${company.id}`) && r.request().method() === 'GET',
        { timeout: 20_000 }
      );
      await editButton.click();
      expect((await detailRead).status(), 'the edit dialog reads the company detail route').toBe(200);
      // Filled from that read.
      await expect(page.locator('input[name="name"]')).toHaveValue(company.name, { timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'Update Company' })).toBeVisible();
    };

    await openDialog();
    // logViewActivity() is awaited before the response goes out, so the row
    // exists by the time the response has arrived; no polling needed.
    const afterOpen = await views();
    expect(afterOpen, 'opening a company in the UI is logged').toHaveLength(1);
    expect(afterOpen[0]).toMatchObject({
      actorId: admin.id,
      actorEmail: adminEmail,
      targetType: 'company',
      targetId: company.id,
      // No company name: the activity feed is not tenant-scoped yet.
      detail: null,
    });

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#company-form-title')).toHaveCount(0);
    await openDialog();
    expect(await views(), 'reopening inside the window writes no second row').toHaveLength(1);

    // A read from another address is a different fact, and the one an incident
    // review asks about. That can only be shown where the server takes the
    // address from X-Real-IP (TRUSTED_PROXY_COUNT=0, the Playwright webServer).
    // Behind a proxy (BASE_URL=https://preview…) the proxy's forwarded header
    // decides, both reads share one address and the split is not observable, so
    // it is asserted only when the first row proves the header was honoured.
    const elsewhere = floodIp('company-view-b');
    const other = await page.request.get(`/api/companies/${company.id}`, { headers: elsewhere });
    expect(other.status()).toBe(200);
    if (afterOpen[0].ip === here['X-Real-IP']) {
      const afterOther = await views();
      expect(afterOther, 'a read from a new origin is its own row').toHaveLength(2);
      expect(afterOther[1].ip).toBe(elsewhere['X-Real-IP']);
    } else {
      test.info().annotations.push({
        type: 'skipped-assertion',
        description: `the server did not take the address from X-Real-IP (stored ${afterOpen[0].ip}); origin split not observable here`,
      });
    }

    // A 404 read nothing, so it logs nothing.
    const missing = await page.request.get(`/api/companies/${missingId}`, { headers: here });
    expect(missing.status()).toBe(404);
    expect(await prisma.activityLog.count({ where: { action: 'company.view', targetId: missingId } })).toBe(0);
  } finally {
    await prisma.activityLog.deleteMany({ where: { action: 'company.view', targetId: { in: [company.id, missingId] } } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
