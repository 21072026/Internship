import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The form builder (#1802). Its own org. An admin creates a form, builds a
// three-locale select field, sees it in the preview in each language with the
// shared validation, cannot make a free-text field matchable, is warned (not
// blocked) about a protected-characteristic proxy, cannot publish a field that
// lacks a locale, and publishes. A mentor gets 403 from every forms route.

const PW = 'FormBuilder123!';

test.describe('form builder', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('fb-admin');
  const mentor = uniqueEmail('fb-mentor');
  let orgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `FB Org ${stamp}`, slug: `fb-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `FB Admin ${stamp}`, orgId);
    await seedUser(mentor, PW, 'MENTOR', `FB Mentor ${stamp}`, orgId);
  });

  test.afterAll(async () => {
    await prisma.formDefinition.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('build a three-locale select, preview it, publish it', async ({ page }) => {
    test.slow();
    const key = `reg_${stamp}`;
    await signInAndSettle(page, admin, PW, '/admin');
    await gotoSettled(page, '/admin/forms');
    await page.getByTestId('form-create-key').fill(key, { timeout: 60_000 });
    await page.getByTestId('form-create-submit').click();
    await page.waitForURL(/\/admin\/forms\/[a-z0-9]+$/, { timeout: 60_000 });
    const formId = page.url().split('/').pop()!;

    // A select field, written in all three languages.
    await page.getByTestId('builder-add-SELECT').click({ timeout: 60_000 });
    await page.getByTestId('builder-key-0').fill('track');
    for (const [l, v] of [['en', 'Which track?'], ['tr', 'Hangi alan?'], ['de', 'Welcher Bereich?']] as const) await page.getByTestId(`builder-label-0-${l}`).fill(v);
    await page.getByTestId('builder-option-0-0-value').fill('web');
    for (const [l, v] of [['en', 'Web'], ['tr', 'Web'], ['de', 'Web']] as const) await page.getByTestId(`builder-option-0-0-${l}`).fill(v);
    await page.getByTestId('builder-add-option-0').click();
    await page.getByTestId('builder-option-0-1-value').fill('data');
    for (const [l, v] of [['en', 'Data'], ['tr', 'Veri']] as const) await page.getByTestId(`builder-option-0-1-${l}`).fill(v);
    await page.getByTestId('builder-required-0').check();

    // The preview renders the participant's field, in the language being edited.
    const preview = page.getByTestId('builder-preview');
    await expect(preview.getByText('Which track?')).toBeVisible();
    await page.getByTestId('builder-preview-locale').selectOption('tr');
    await expect(preview.getByText('Hangi alan?')).toBeVisible();
    await expect(preview.getByTestId('preview-track').locator('option')).toHaveText([/./, 'Web', 'Veri']);
    // Validation is the shared validateResponse(): a required field left empty.
    await page.getByTestId('builder-preview-errors').check();
    await expect(preview.getByTestId('preview-track-error')).toBeVisible();
    await preview.getByTestId('preview-track').selectOption('data');
    await expect(preview.getByTestId('preview-track-error')).toHaveCount(0);

    // Free text can never feed matching — the toggle is disabled.
    await page.getByTestId('builder-add-LONG_TEXT').click();
    await expect(page.getByTestId('builder-matchable-1')).toBeDisabled();
    // A proxy for a protected characteristic warns, never blocks.
    await page.getByTestId('builder-key-1').fill('birth_year');
    await expect(page.getByTestId('builder-proxy-warning-1')).toBeVisible();
    for (const l of ['en', 'tr', 'de'] as const) await page.getByTestId(`builder-label-1-${l}`).fill(`Year ${l}`);

    // The 'data' option lacks German: publishing is refused, by the server.
    await page.getByTestId('builder-publish').click();
    await page.getByRole('button', { name: /^Publish$/ }).last().click();
    await expect(page.getByTestId('builder-message')).toContainText('track');
    expect((await prisma.formDefinition.findUniqueOrThrow({ where: { id: formId } })).publishedAt).toBeNull();

    await page.getByTestId('builder-option-0-1-de').fill('Daten');
    await page.getByTestId('builder-publish').click();
    await page.getByRole('button', { name: /^Publish$/ }).last().click();
    await expect(page.getByTestId('builder-version-badge')).toContainText('Live', { timeout: 30_000 });
    const saved = await prisma.formDefinition.findUniqueOrThrow({ where: { id: formId }, include: { fields: { orderBy: { sortOrder: 'asc' } } } });
    expect(saved.publishedAt).not.toBeNull();
    expect(saved.fields.map((f) => [f.key, f.type, f.required, f.matchable])).toEqual([['track', 'SELECT', true, false], ['birth_year', 'LONG_TEXT', false, false]]);
    expect(saved.fields[0].labels).toEqual({ en: 'Which track?', tr: 'Hangi alan?', de: 'Welcher Bereich?' });

    // The API refuses matchable free text too, not only the toggle.
    const refused = await page.request.put(`/api/admin/forms/${formId}`, { data: { fields: [{ key: 'bio', type: 'TEXT', labels: { en: 'x', tr: 'x', de: 'x' }, matchable: true }] } });
    expect([refused.status(), (await refused.json()).code]).toEqual([400, 'not_matchable']);
  });

  test('a non-admin gets 403 from every forms route', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    const any = await prisma.formDefinition.findFirst({ where: { orgId }, select: { id: true } });
    const id = any?.id ?? 'x';
    expect((await page.request.get('/api/admin/forms')).status()).toBe(403);
    expect((await page.request.post('/api/admin/forms', { data: {} })).status()).toBe(403);
    expect((await page.request.get(`/api/admin/forms/${id}`)).status()).toBe(403);
    expect((await page.request.put(`/api/admin/forms/${id}`, { data: { fields: [] } })).status()).toBe(403);
    expect((await page.request.delete(`/api/admin/forms/${id}`)).status()).toBe(403);
    expect((await page.request.post(`/api/admin/forms/${id}/publish`)).status()).toBe(403);
  });
});
