import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// #1625: two admin-surface gaps. `aiMonthlyQuota` was enforced by the AI gate
// but rendered nowhere, so it could only be changed with a raw API call; and
// the per-tenant pipeline-stage editor was hardcoded English in an otherwise
// trilingual product.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the monthly AI quota round-trips through the settings form', async ({ page }) => {
  const adminEmail = uniqueEmail('quota-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Quota Admin');
  // Whatever the API resolves right now (tenant row → global row → code
  // default). The save below writes a real row through the browser, so the
  // value is put back the same way in `finally`: a Prisma cleanup would edit
  // the local database rather than the one the page just changed whenever the
  // suite runs against a deployed BASE_URL.
  let original: string | null = null;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    original = (await (await page.request.get('/api/admin/settings')).json()).settings.aiMonthlyQuota ?? null;
    expect(original).toMatch(/^\d{1,6}$/);

    await gotoSettled(page, '/admin/settings');

    // AdminNav renders its own sidebar input[type="search"] on every admin
    // page, and this form holds a handful of number inputs — hence the testid.
    const quota = page.getByTestId('ai-monthly-quota');
    // The resolved value is rendered, not an empty box.
    await expect(quota).toHaveValue(String(original), { timeout: 20_000 });
    // A numeric control server-side-validated by /^\d{1,6}$/.
    await expect(quota).toHaveAttribute('type', 'number');

    await quota.fill('37');
    // Scoped to the form that owns the field: the settings page carries other
    // editors (evaluation framework, stage SLAs) with save buttons of their own.
    await page
      .locator('form')
      .filter({ has: page.getByTestId('ai-monthly-quota') })
      .getByRole('button', { name: 'Save settings' })
      .click();

    // Persisted for the caller's tenant, and read back by the API the AI gate
    // itself reads through — no restart involved.
    await expect
      .poll(async () => (await (await page.request.get('/api/admin/settings')).json()).settings.aiMonthlyQuota, {
        timeout: 15_000,
      })
      .toBe('37');

    // And the form shows the stored value on a fresh load rather than the default.
    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('ai-monthly-quota')).toHaveValue('37', { timeout: 20_000 });
  } finally {
    if (original !== null) {
      await page.request
        .put('/api/admin/settings', { data: { aiMonthlyQuota: original } })
        .catch(() => {});
    }
    await cleanupByEmail(adminEmail);
  }
});

// #2342: the form starts on code defaults (quota '200') and fills itself from
// GET /api/admin/settings. On a slow runner the test above typed 37 before that
// GET answered, the late load put 200 back, and the save carried no quota. The
// form is now locked until the stored values are in. This test makes the slow
// runner deterministic by holding the page's own GET for 3s: Playwright's
// `fill` waits for the box to become editable, so on the fixed form it types
// after the load; on the unfixed one it types into the defaults and loses.
test('a value typed while the settings are still loading is not lost to the late load', async ({ page }) => {
  const adminEmail = uniqueEmail('quota-race-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Quota Race Admin');
  let original: string | null = null;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    // `page.request` is not routed, so these reads see the real API at once.
    original = (await (await page.request.get('/api/admin/settings')).json()).settings.aiMonthlyQuota ?? null;
    const target = original === '41' ? '42' : '41';

    await page.route('**/api/admin/settings', async (route) => {
      if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 3_000));
      await route.continue();
    });
    await page.goto('/admin/settings');

    const form = page.getByTestId('settings-form');
    // While the GET is held the form is locked, not an editable box of defaults.
    await expect(form).toHaveAttribute('data-state', 'loading', { timeout: 20_000 });
    await expect(page.getByTestId('ai-monthly-quota')).toBeDisabled();

    await page.getByTestId('ai-monthly-quota').fill(target, { timeout: 20_000 });
    await expect(form).toHaveAttribute('data-state', 'ready');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/settings') && r.request().method() === 'PUT');
    await form.getByRole('button', { name: 'Save settings' }).click();
    expect((await saved).ok()).toBe(true);

    await expect
      .poll(async () => (await (await page.request.get('/api/admin/settings')).json()).settings.aiMonthlyQuota, {
        timeout: 15_000,
      })
      .toBe(target);
  } finally {
    await page.unroute('**/api/admin/settings').catch(() => {});
    if (original !== null) {
      await page.request.put('/api/admin/settings', { data: { aiMonthlyQuota: original } }).catch(() => {});
    }
    await cleanupByEmail(adminEmail);
  }
});

test('a settings load that fails leaves the form locked and says why', async ({ page }) => {
  const adminEmail = uniqueEmail('quota-fail-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Quota Fail Admin');
  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await page.route('**/api/admin/settings', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 500, body: '{}' }) : route.continue(),
    );
    await page.goto('/admin/settings');
    await expect(page.getByTestId('settings-load-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('settings-form')).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('ai-monthly-quota')).toBeDisabled();
    await expect(page.getByTestId('settings-form').getByRole('button', { name: 'Save settings' })).toBeDisabled();

    // The retry reaches the real API once the fault is gone.
    await page.unroute('**/api/admin/settings');
    await page.getByTestId('settings-load-error').getByRole('button').click();
    await expect(page.getByTestId('settings-form')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.getByTestId('settings-load-error')).toHaveCount(0);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('the pipeline-stage editor renders in Turkish with no English left', async ({ page }) => {
  const adminEmail = uniqueEmail('stage-i18n-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Stage I18n Admin');
  // Managing another tenant's stages is super-admin only (#1535).
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
  const slug = `e2e-stage-i18n-${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `Stage I18n ${slug}`, slug } });

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    // Same trick as i18n-coverage.spec: the locale cookie wins over the stored
    // user preference, and needs an origin to be set on.
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });

    await gotoSettled(page, `/admin/organizations/${org.id}/pipeline`);
    const editor = page.getByTestId('pipeline-stages-editor');
    await expect(editor.getByRole('heading', { name: 'Pipeline aşamaları', exact: true })).toBeVisible({ timeout: 20_000 });

    // The stage rows have loaded (the fresh org uses the built-in defaults), so
    // the assertions below are made against the finished page, not its shell.
    await expect(editor.locator('input[type="color"]').first()).toBeVisible({ timeout: 20_000 });

    // Turkish copy that only exists on this page. Asserted against the element
    // that holds exactly this sentence — it shares its paragraph with the
    // subtitle, so a text locator with `exact: true` would match nothing.
    await expect(editor.getByTestId('pipeline-stages-source')).toHaveText('Bu kurum yerleşik varsayılan aşamaları kullanıyor.');
    // A new org is on FREE, so the paid-plan notice is on screen too.
    await expect(editor.getByText(/ücretli bir plan gerektirir/)).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Kaydet', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Varsayılanlara dön', exact: true })).toBeVisible();
    // The save hint must not promise a partial edit — the PUT replaces the set.
    await expect(editor.getByText(/tamamını yukarıdaki satırlarla değiştirir/)).toBeVisible();

    // No English left anywhere in the editor. Scoped to the page container, so
    // the surrounding admin shell is not what is being measured.
    const text = await editor.innerText();
    for (const english of [
      'Pipeline stages',
      'Customize this organization',
      'This tenant uses',
      'require a paid plan',
      'off-path',
      'terminal',
      'Reset to defaults',
      'Loading',
    ]) {
      expect(text, `untranslated string on the stage editor: ${english}`).not.toContain(english);
    }
    // "Save" on its own would match nothing here in Turkish, but an English
    // button would — assert it by role rather than by substring.
    await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // The canonical stage KEYS are deliberately still shown verbatim: they are
    // identifiers, not copy, and the editor labels them separately.
    expect(text).toContain('APPLICATION_100');
  } finally {
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
    await cleanupByEmail(adminEmail);
  }
});
