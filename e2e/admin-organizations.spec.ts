import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Multi-tenancy (#544): super-admin Organizations screen — create a tenant and
// see it listed with per-tenant counts. Phase 1 is additive (orgId nullable,
// no query isolation yet), so this only exercises listing + creation + authz.

const createdSlugs: string[] = [];

test.afterAll(async () => {
  for (const slug of createdSlugs) {
    await prisma.organization.deleteMany({ where: { slug } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('admin creates an organization and it appears in the list', async ({ page }) => {
  const adminEmail = uniqueEmail('org-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Org Admin');
  // Tenant management is super-admin only (#1535); a plain ADMIN is a tenant
  // admin and is covered by the third test below.
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
  const tag = Date.now();
  const orgName = `E2E Org ${tag}`;
  const orgSlug = `e2e-org-${tag}`;
  createdSlugs.push(orgSlug);

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');

    await gotoSettled(page, '/admin/organizations');
    // exact: the list card's title renders "Organizations (N)" and would also match.
    await expect(page.getByRole('heading', { name: 'Organizations', exact: true })).toBeVisible();

    // Create via the form.
    // `Input` renders the required marker inside the <label>, so this label's
    // text is literally "Name*" — getByLabel matches label text content, so an
    // exact 'Name' never matches. A plain non-exact 'Name' would also hit
    // "Brand name", hence the anchored regex.
    await page.getByLabel(/^Name\*?$/).fill(orgName);
    await page.getByLabel(/^Slug\*?$/).fill(orgSlug);
    await page.getByRole('button', { name: 'Create' }).click();

    // New org row shows up with its slug.
    await expect(page.locator('table').getByText(orgName, { exact: true })).toBeVisible({ timeout: 10_000 });

    // Persisted in the DB, defaults to the FREE plan.
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    expect(org?.name).toBe(orgName);
    expect(org?.plan).toBe('FREE');

    // Change the plan to PRO via the row selector; it persists.
    await page.getByTestId(`org-plan-${org!.id}`).selectOption('PRO');
    await expect.poll(async () =>
      (await prisma.organization.findUnique({ where: { id: org!.id } }))?.plan,
      { timeout: 10_000 },
    ).toBe('PRO');

    // White-label branding (#546): set fields via the API and confirm persistence.
    const brand = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandName: 'Acme Talent', brandColor: '#2563eb', supportEmail: 'help@acme.test' },
    });
    expect(brand.ok()).toBeTruthy();
    const branded = await prisma.organization.findUnique({ where: { id: org!.id } });
    expect(branded?.brandName).toBe('Acme Talent');
    expect(branded?.brandColor).toBe('#2563eb');

    // A bad hex color is rejected.
    const badColor = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandColor: 'notacolor' },
    });
    expect(badColor.status()).toBe(400);

    // The logo URL is fetched BY THE SERVER when a certificate is rendered, so
    // an internal address here is an SSRF vector, not a broken image — the
    // scheme is checked on write for the same reason ssoEntryPoint is below.
    for (const logo of [
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://127.0.0.1:3306', // the database, from the server's position
      'http://example.test/logo.png', // plaintext
      '//evil.test/logo.png', // protocol-relative: a foreign host in disguise
      'javascript:alert(1)',
      'https://user:pass@example.test/logo.png', // embedded credentials
    ]) {
      const res = await page.request.patch('/api/admin/organizations', {
        data: { id: org!.id, brandLogoUrl: logo },
      });
      expect(res.status(), `logo URL should be refused: ${logo}`).toBe(400);
    }
    // …and it is still unset, so a refused value never reached the row.
    expect((await prisma.organization.findUnique({ where: { id: org!.id } }))?.brandLogoUrl).toBeNull();

    // The three legitimate shapes are accepted.
    for (const logo of ['https://cdn.example.test/logo.svg', '/logo.svg', 'data:image/png;base64,iVBORw0KGgo=']) {
      const res = await page.request.patch('/api/admin/organizations', {
        data: { id: org!.id, brandLogoUrl: logo },
      });
      expect(res.ok(), `logo URL should be accepted: ${logo}`).toBeTruthy();
      expect((await prisma.organization.findUnique({ where: { id: org!.id } }))?.brandLogoUrl).toBe(logo);
    }

    // A blank field clears the override.
    const clear = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandName: '' },
    });
    expect(clear.ok()).toBeTruthy();
    const cleared = await prisma.organization.findUnique({ where: { id: org!.id } });
    expect(cleared?.brandName).toBeNull();

    // Enterprise SSO (#545): cannot enable without a complete config.
    const badEnable = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, ssoEnabled: true, ssoProvider: 'saml' },
    });
    expect(badEnable.status()).toBe(400);

    // A non-https entry point is rejected.
    const badUrl = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, ssoProvider: 'saml', ssoEntryPoint: 'http://idp.test/sso' },
    });
    expect(badUrl.status()).toBe(400);

    // A complete SAML config enables and reports active.
    const goodSso = await page.request.patch('/api/admin/organizations', {
      data: {
        id: org!.id,
        ssoEnabled: true,
        ssoProvider: 'saml',
        ssoIssuer: 'https://idp.test/metadata',
        ssoEntryPoint: 'https://idp.test/sso',
        ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----',
      },
    });
    expect(goodSso.ok()).toBeTruthy();
    const ssoOrg = await prisma.organization.findUnique({ where: { id: org!.id } });
    expect(ssoOrg?.ssoEnabled).toBe(true);
    expect(ssoOrg?.ssoProvider).toBe('saml');

    // The GET list never leaks the raw certificate.
    const listed = await (await page.request.get('/api/admin/organizations')).json();
    const row = listed.organizations.find((o: { id: string }) => o.id === org!.id);
    expect(row.sso.ssoCertificateSet).toBe(true);
    expect(row.sso.active).toBe(true);
    expect(row.sso).not.toHaveProperty('ssoCertificate');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('non-admin cannot list or create organizations', async ({ page }) => {
  const mentorEmail = uniqueEmail('org-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Org Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const list = await page.request.get('/api/admin/organizations');
    expect(list.status()).toBe(401);

    const create = await page.request.post('/api/admin/organizations', {
      data: { name: 'Should Fail', slug: `should-fail-${Date.now()}` },
    });
    expect(create.status()).toBe(401);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

// Cross-tenant gate (#1535). The dangerous field here is the SAML signing
// certificate: whoever can write it decides who may mint a login for that
// tenant. Both directions are asserted — a tenant admin keeps their own
// organisation, and is refused everything belonging to somebody else.
test('a tenant admin can only reach their own organization', async ({ page }) => {
  const tag = Date.now();
  const ownSlug = `e2e-own-${tag}`;
  const foreignSlug = `e2e-foreign-${tag}`;
  createdSlugs.push(ownSlug, foreignSlug);

  const own = await prisma.organization.create({ data: { slug: ownSlug, name: `Own Tenant ${tag}` } });
  const foreign = await prisma.organization.create({
    data: {
      slug: foreignSlug,
      name: `Foreign Tenant ${tag}`,
      ssoProvider: 'saml',
      ssoIssuer: 'https://foreign-idp.test/metadata',
      ssoEntryPoint: 'https://foreign-idp.test/sso',
      ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIBforeign\n-----END CERTIFICATE-----',
    },
  });

  const adminEmail = uniqueEmail('tenant-admin');
  const admin = await seedUser(adminEmail, 'TenantPass123', 'ADMIN', 'Tenant Admin');
  // A plain tenant ADMIN: role ADMIN, orgId set, isSuperAdmin left at false.
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: own.id } });

  try {
    await signInAndSettle(page, adminEmail, 'TenantPass123', '/admin');

    // GET returns exactly one row — their own — and says they are not a super admin.
    const listed = await (await page.request.get('/api/admin/organizations')).json();
    expect(listed.superAdmin).toBe(false);
    expect(listed.organizations).toHaveLength(1);
    expect(listed.organizations[0].id).toBe(own.id);

    // Creating a tenant is refused.
    const create = await page.request.post('/api/admin/organizations', {
      data: { name: 'Sneaky Tenant', slug: `sneaky-${tag}` },
    });
    expect(create.status()).toBe(403);
    expect(await prisma.organization.findUnique({ where: { slug: `sneaky-${tag}` } })).toBeNull();

    // Their own organization is still editable.
    const ownPatch = await page.request.patch('/api/admin/organizations', {
      data: { id: own.id, brandName: 'Own Brand' },
    });
    expect(ownPatch.ok()).toBeTruthy();
    expect((await prisma.organization.findUnique({ where: { id: own.id } }))?.brandName).toBe('Own Brand');

    // The foreign tenant's SSO config is refused, and untouched afterwards.
    const foreignPatch = await page.request.patch('/api/admin/organizations', {
      data: {
        id: foreign.id,
        ssoEnabled: true,
        ssoProvider: 'saml',
        ssoIssuer: 'https://attacker.test/metadata',
        ssoEntryPoint: 'https://attacker.test/sso',
        ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIBattacker\n-----END CERTIFICATE-----',
      },
    });
    expect(foreignPatch.status()).toBe(403);
    const untouched = await prisma.organization.findUnique({ where: { id: foreign.id } });
    expect(untouched?.ssoEntryPoint).toBe('https://foreign-idp.test/sso');
    expect(untouched?.ssoCertificate).toContain('MIIBforeign');
    expect(untouched?.ssoEnabled).toBe(false);

    // An id that does not exist is also a 403, never a 404 — the response must
    // not tell a foreign admin which organization ids are real.
    const missing = await page.request.patch('/api/admin/organizations', {
      data: { id: 'no-such-org-id', brandName: 'Nope' },
    });
    expect(missing.status()).toBe(403);

    // The sub-route follows the same rule: own org readable, foreign refused.
    const ownStages = await page.request.get(`/api/admin/organizations/${own.id}/pipeline-stages`);
    expect(ownStages.ok()).toBeTruthy();
    const foreignStages = await page.request.get(`/api/admin/organizations/${foreign.id}/pipeline-stages`);
    expect(foreignStages.status()).toBe(403);
    const foreignStageWrite = await page.request.delete(`/api/admin/organizations/${foreign.id}/pipeline-stages`);
    expect(foreignStageWrite.status()).toBe(403);

    // The refusal is on record for an auditor.
    await expect.poll(async () => prisma.activityLog.count({
      where: { actorId: admin.id, action: 'authz.scope_denied' },
    }), { timeout: 10_000 }).toBeGreaterThan(0);

    // Presentation follows the capability: no create form, and a note saying why.
    await gotoSettled(page, '/admin/organizations');
    await expect(page.getByTestId('tenant-scope-note')).toBeVisible();
    await expect(page.getByTestId('new-org-card')).toHaveCount(0);
    // Their own organization is still listed (scoped to the table: the name also
    // appears in the branding/SSO <select> options).
    await expect(page.locator('table').getByText(`Own Tenant ${tag}`, { exact: true })).toBeVisible();
    await expect(page.locator('table').getByText(`Foreign Tenant ${tag}`, { exact: true })).toHaveCount(0);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
