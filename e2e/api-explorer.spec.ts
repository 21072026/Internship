import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function login(page: Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
}

// The admin API explorer (#1447) — Swagger UI over the FULL internal surface.
//
// The gate is the security-relevant half and carries the @smoke tag: this
// document is a complete inventory of every route, every guard and every
// request body in the app, so "an anonymous caller gets 401" is a claim worth
// re-checking on every PR. The rendering and token-minting tests are the
// feature's own coverage and run in the scheduled full suite.

test('the API description is not readable without an admin session', { tag: '@smoke' }, async ({ page }) => {
  // Anonymous: no session at all.
  const anon = await page.request.get('/api/admin/openapi');
  expect(anon.status()).toBe(401);

  // A signed-in NON-admin must not reach it either — the page redirect alone is
  // not a gate, and a mentee with a valid session is the realistic attacker.
  const email = uniqueEmail('apiexp-mentee');
  const pw = 'ApiExpPass123!';
  await seedUser(email, pw, 'MENTEE', 'API Explorer Mentee');
  try {
    await login(page, email, pw);
    const asMentee = await page.request.get('/api/admin/openapi');
    expect(asMentee.status()).toBe(401);

    // And the page itself bounces a non-admin out of /admin.
    await page.goto('/admin/api-explorer');
    await expect(page).not.toHaveURL(/\/admin\/api-explorer/);
  } finally {
    await cleanupByEmail(email);
  }

  // The PUBLIC spec is deliberately still public — this feature must not have
  // taken the documented integrator surface away.
  const pub = await page.request.get('/api/v1/openapi.json');
  expect(pub.ok()).toBeTruthy();
  expect((await pub.json()).paths['/candidates']).toBeTruthy();
});

test('an admin gets a description covering both the public and the internal surface', async ({ page }) => {
  const email = uniqueEmail('apiexp-admin');
  const pw = 'ApiExpPass123!';
  await seedUser(email, pw, 'ADMIN', 'API Explorer Admin');
  try {
    await login(page, email, pw);

    const res = await page.request.get('/api/admin/openapi');
    expect(res.status()).toBe(200);
    const spec = await res.json();

    expect(spec.openapi).toMatch(/^3\.1/);
    // Both auth modes the screen offers must be declared, under the exact names
    // ApiExplorer.tsx passes to preauthorizeApiKey().
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['bearerApiKey', 'sessionCookie']);

    // "tüm endpointler … internal endpointler dahil": a public one AND internal
    // admin/cron routes that the public document deliberately omits.
    expect(spec.paths['/api/v1/candidates']).toBeTruthy();
    expect(spec.paths['/api/admin/api-keys']).toBeTruthy();
    expect(spec.paths['/api/cron/start']).toBeTruthy();

    // Guards are classified, not guessed: an /api/admin route must never be
    // described as needing no credential.
    expect(spec.paths['/api/admin/api-keys'].post['x-auth']).toBe('admin-session');

    // The whole surface, not a curated subset. 195 paths / 303 operations at the
    // time of writing; the floor only guards against the generator silently
    // regressing to a handful.
    const paths = Object.keys(spec.paths).length;
    expect(paths).toBeGreaterThan(150);

    // No secret VALUE may ride along in a document assembled from source files.
    const raw = JSON.stringify(spec);
    expect(raw).not.toMatch(/NEXTAUTH_SECRET|mysql:\/\/|icrm_[0-9a-f]{8}/);
  } finally {
    await cleanupByEmail(email);
  }
});

test('Swagger UI renders the operations and the token button pre-authorizes it', async ({ page }) => {
  const email = uniqueEmail('apiexp-ui');
  const pw = 'ApiExpPass123!';
  const admin = await seedUser(email, pw, 'ADMIN', 'API Explorer UI Admin');
  try {
    await login(page, email, pw);
    await page.goto('/admin/api-explorer');

    // The warning is server-rendered, so it proves the page itself loaded
    // before the ~1.2 MB Swagger chunk is even requested.
    await expect(page.getByTestId('api-explorer-warning')).toBeVisible();

    // Swagger UI actually mounted: assert on a real rendered artefact inside
    // its container, not merely that the route returned 200. Scoped to the
    // container because AdminNav renders its own sidebar filter box — an
    // unscoped input[type="search"] would hit that instead (CLAUDE.md).
    const ui = page.getByTestId('api-explorer-ui');
    const tags = ui.locator('.opblock-tag');
    await expect(tags.first()).toBeVisible({ timeout: 60_000 });
    // Every tag group the generator emitted, not a token handful.
    expect(await tags.count()).toBeGreaterThan(20);
    // Its own filter box lives inside the widget, and is how you survive ~300
    // operations. Scoped to the container: AdminNav renders its own sidebar
    // filter box, so an unscoped input selector hits that instead (CLAUDE.md).
    await expect(ui.locator('.filter input')).toBeVisible();
    // docExpansion: 'none' means the groups start collapsed, so the individual
    // operations are not in the DOM until one is opened — expanding is the only
    // way to prove real operations rendered rather than just their headings.
    await tags.first().click();
    await expect(ui.locator('.opblock').first()).toBeVisible({ timeout: 20_000 });

    // The endpoint count the header reports comes from the same parse as the
    // spec, so a non-empty count means the document arrived intact.
    await expect(page.getByTestId('api-explorer-counts')).toContainText(/\d{3}/);

    // The no-copy-paste claim: one click mints a key AND fills the Authorize
    // dialog. Assert the mint + one-time reveal first (that is the durable
    // part), then that Swagger's own auth state took the value.
    await page.getByTestId('api-explorer-generate').click();
    const shown = page.getByTestId('api-explorer-key');
    await expect(shown).toBeVisible({ timeout: 20_000 });
    await expect(shown).toContainText(/^icrm_[0-9a-f]{32,}$/);

    // The Authorize dialog is the only honest place to read Swagger's auth
    // state: persistAuthorization is deliberately off (see ApiExplorer.tsx), so
    // nothing is mirrored into localStorage. An authorized scheme renders as
    // "Authorized" with a Logout button, an unauthorized one as a Value input.
    await ui.locator('button.authorize').first().click();
    const dialog = page.locator('.dialog-ux .modal-ux-content');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const bearerSection = dialog.locator('.auth-container', { hasText: 'bearerApiKey' });
    await expect(bearerSection).toContainText('Authorized');
    // Swagger's logout control is labelled by aria-label ("Remove
    // authorization"), not by its "Logout" text — matching on the text would
    // pass for the wrong reason or not at all.
    await expect(bearerSection.getByRole('button', { name: 'Remove authorization' })).toBeVisible();
    // The credential is masked, not echoed back into the DOM. (The scheme's own
    // description mentions the `icrm_` prefix, so match the key itself.)
    await expect(bearerSection).toContainText('******');
    await expect(bearerSection).not.toContainText(/icrm_[0-9a-f]{16}/);
    await bearerSection.getByRole('button', { name: 'Close' }).click();

    // The key really is usable on the surface it claims to cover.
    const raw = (await shown.textContent())!.trim();
    const v1 = await page.request.get('/api/v1/candidates', { headers: { Authorization: `Bearer ${raw}` } });
    expect(v1.status()).toBe(200);

    // Revoking from the page invalidates it again.
    await page.getByTestId('api-explorer-revoke').click();
    await page.getByRole('button', { name: /revoke|iptal et|sil|widerruf/i }).last().click();
    await expect(shown).toBeHidden({ timeout: 20_000 });
    await expect
      .poll(async () => (await page.request.get('/api/v1/candidates', { headers: { Authorization: `Bearer ${raw}` } })).status(), { timeout: 20_000 })
      .toBe(401);
  } finally {
    // The minted keys are not tied to the user row, so clear them explicitly.
    await prisma.apiKey.deleteMany({ where: { name: { startsWith: 'Swagger UI' } } });
    await prisma.user.delete({ where: { id: admin.id } }).catch(() => {});
    await cleanupByEmail(email);
  }
});
