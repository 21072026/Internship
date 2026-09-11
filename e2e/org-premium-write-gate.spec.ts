import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Premium write gate (#1742). White-label branding and SAML SSO are the two
// headline paid features and PATCH /api/admin/organizations is the only way
// either is written — so the entitlement is enforced there, not by the admin
// role and not by the screen. Everything here goes through page.request on
// purpose: the UI is bypassed exactly the way an unentitled tenant would bypass
// it. The interim source of truth is the org's plan (src/lib/orgPlans.ts →
// orgPlanHasFeature); #1733 will swap that out without changing this contract.

const SAML = {
  ssoEnabled: true,
  ssoProvider: 'saml',
  ssoIssuer: 'https://idp.gate.test/metadata',
  ssoEntryPoint: 'https://idp.gate.test/sso',
  ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIBgate\n-----END CERTIFICATE-----',
};

test('the plan, not the admin role, decides who may write branding and SSO', async ({ page }) => {
  const tag = `${Date.now()}`;
  const slug = `e2e-gate-${tag}`;
  const org = await prisma.organization.create({
    data: { slug, name: `Gate Tenant ${tag}`, plan: 'FREE' },
  });
  const adminEmail = uniqueEmail('gate-admin');
  const admin = await seedUser(adminEmail, 'GatePass123', 'ADMIN', 'Gate Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });

  const patch = (data: Record<string, unknown>) =>
    page.request.patch('/api/admin/organizations', { data: { id: org.id, ...data } });
  const row = () => prisma.organization.findUnique({ where: { id: org.id } });
  // Plan moves happen in the DB here, never through the API: setting the tier is
  // a super-admin act and this actor is a plain tenant admin (asserted below).
  const plan = (p: 'FREE' | 'PRO' | 'ENTERPRISE') =>
    prisma.organization.update({ where: { id: org.id }, data: { plan: p } });
  const listed = async () => {
    const body = await (await page.request.get('/api/admin/organizations')).json();
    return body.organizations.find((o: { id: string }) => o.id === org.id);
  };

  try {
    await signInAndSettle(page, adminEmail, 'GatePass123', '/admin');

    // --- FREE: neither feature may be written --------------------------------
    const lockedBrand = await patch({ brandName: 'Gate Brand', brandColor: '#2563eb' });
    expect(lockedBrand.status()).toBe(403);
    // requiredPlan names the tier that sells it, so the upgrade CTA does not
    // have to re-derive the packaging (#1736).
    expect(await lockedBrand.json()).toMatchObject({
      code: 'feature_locked', feature: 'WHITE_LABEL', requiredPlan: 'ENTERPRISE',
    });

    const lockedSso = await patch(SAML);
    expect(lockedSso.status()).toBe(403);
    expect(await lockedSso.json()).toMatchObject({
      code: 'feature_locked', feature: 'SSO_SAML', requiredPlan: 'ENTERPRISE',
    });

    // Nothing leaked past the gate — the refusal is before the write, not after.
    const untouched = await row();
    expect(untouched?.brandName).toBeNull();
    expect(untouched?.ssoProvider).toBeNull();
    expect(untouched?.ssoEnabled).toBe(false);

    // --- The gate cannot be bought by the actor it gates ----------------------
    // THE escalation this whole slice turns on: the entitlement is read from
    // Organization.plan, so a tenant admin who could write that field would
    // simply upgrade himself and walk through. Changing the tier is super-admin
    // only, both on its own…
    const selfUpgrade = await patch({ plan: 'ENTERPRISE' });
    expect(selfUpgrade.status()).toBe(403);
    expect((await row())?.plan).toBe('FREE');

    // …and bundled into the same request as the config it would unlock, which is
    // the shape that would otherwise defeat the check in one round trip.
    const bundled = await patch({ plan: 'ENTERPRISE', ...SAML });
    expect(bundled.status()).toBe(403);
    const afterBundled = await row();
    expect(afterBundled?.plan).toBe('FREE');
    expect(afterBundled?.ssoEntryPoint).toBeNull();

    // Echoing back the plan the org is already on is not a change, so a client
    // that always sends the current value is not broken by the rule.
    expect((await patch({ plan: 'FREE' })).ok()).toBeTruthy();

    // --- The same rule for the vertical (#2350) ------------------------------
    // Which PRODUCT a tenant is decides which modules exist for everyone in it,
    // and later slices read it to gate write paths — so a tenant admin switching
    // their own org's vertical is the same class of act as self-upgrading the
    // plan, and is refused the same way.
    expect((await row())?.vertical).toBe('INTERNSHIP');
    const selfSwitch = await patch({ vertical: 'MARKETING' });
    expect(selfSwitch.status()).toBe(403);
    expect((await row())?.vertical).toBe('INTERNSHIP');

    // Bundled with a legitimate write, the whole request is refused — the
    // refusal is before the write, not after it.
    const bundledVertical = await patch({ vertical: 'MARKETING', brandName: 'Gate Brand' });
    expect(bundledVertical.status()).toBe(403);
    const afterVertical = await row();
    expect(afterVertical?.vertical).toBe('INTERNSHIP');
    expect(afterVertical?.brandName).toBeNull();

    // A key the catalogue does not know is a 400 from the schema, never a
    // stored string: the column must not be able to hold a value the app
    // cannot resolve.
    expect((await patch({ vertical: 'NOT_A_VERTICAL' })).status()).toBe(400);
    expect((await row())?.vertical).toBe('INTERNSHIP');

    // Echoing the current vertical back is a no-op, not a change.
    expect((await patch({ vertical: 'INTERNSHIP' })).ok()).toBeTruthy();

    // --- PRO: white-label is Enterprise packaging, so still locked -----------
    // docs/premium-model-calismasi.md puts BOTH features in Enterprise; Pro buys
    // scale, analytics and the AI package.
    await plan('PRO');
    expect((await patch({ brandName: 'Gate Brand' })).status()).toBe(403);
    expect((await patch(SAML)).status()).toBe(403);

    // --- ENTERPRISE: both unlock, SSO goes active ----------------------------
    await plan('ENTERPRISE');
    expect((await patch({ brandName: 'Gate Brand', brandColor: '#2563eb' })).ok()).toBeTruthy();
    expect((await row())?.brandName).toBe('Gate Brand');
    expect((await patch(SAML)).ok()).toBeTruthy();
    expect((await row())?.ssoEnabled).toBe(true);
    expect((await listed()).sso.active).toBe(true);

    // --- Downgrade: config survives, only activation is withdrawn ------------
    // The whole point of gating isSsoActive() instead of deleting rows: a lapsed
    // plan must not cost the customer's IT team another trip through their IdP.
    await plan('FREE');
    const afterDowngrade = await row();
    expect(afterDowngrade?.brandName).toBe('Gate Brand');
    expect(afterDowngrade?.ssoEntryPoint).toBe(SAML.ssoEntryPoint);
    expect(afterDowngrade?.ssoCertificate).toContain('MIIBgate');
    expect(afterDowngrade?.ssoEnabled).toBe(true); // the switch is still on…
    expect((await listed()).sso.active).toBe(false); // …but the tenant is not live

    // …and the IdP is genuinely no longer accepted at sign-in.
    const login = await page.request.get(`/api/auth/sso/${slug}/login`, { maxRedirects: 0 });
    expect(login.headers()['location']).toContain('sso_unavailable');

    // SETTING a premium value is refused again while unentitled, and changes nothing.
    expect((await patch({ brandName: 'Should Not Stick' })).status()).toBe(403);
    expect((await row())?.brandName).toBe('Gate Brand');

    // …but UNDOING is always allowed. The gate stops a tenant acquiring a paid
    // feature, not removing one it no longer pays for — otherwise white-label is
    // bought once and renders in every branded e-mail and on the certificate PDF
    // forever, and the dead SSO switch can never be turned off.
    expect((await patch({ ssoEnabled: false })).ok()).toBeTruthy();
    expect((await row())?.ssoEnabled).toBe(false);
    expect((await patch({ brandName: '', brandLogoUrl: '', brandColor: '', supportEmail: '' })).ok()).toBeTruthy();
    const cleared = await row();
    expect(cleared?.brandName).toBeNull();
    expect(cleared?.brandColor).toBeNull();
    // A clear must not be a smuggling route: one blank field alongside a real
    // value is still a write, and still refused.
    expect((await patch({ brandName: '', brandColor: '#ff0000' })).status()).toBe(403);
    expect((await row())?.brandColor).toBeNull();

    // --- Re-upgrade: the surviving IdP config resumes with nothing re-entered -
    await plan('ENTERPRISE');
    expect((await patch({ ssoEnabled: true })).ok()).toBeTruthy();
    expect((await listed()).sso.active).toBe(true);

    // The screen mirrors the gate (cosmetic — the 403s above are the control),
    // and offers the way out rather than only a dead end.
    await patch({ brandName: 'Gate Brand' });
    await plan('FREE');
    await gotoSettled(page, '/admin/organizations');
    await page.getByTestId('brand-org-select').selectOption(org.id);
    await expect(page.getByTestId('branding-locked')).toBeVisible();
    await expect(page.getByTestId('brand-save')).toBeDisabled();
    await page.getByTestId('brand-clear').click();
    await expect.poll(async () => (await row())?.brandName, { timeout: 10_000 }).toBeNull();

    await page.getByTestId('sso-org-select').selectOption(org.id);
    await expect(page.getByTestId('sso-locked')).toBeVisible();
    await expect(page.getByTestId('sso-save')).toBeDisabled();
    await page.getByTestId('sso-disable').click();
    await expect.poll(async () => (await row())?.ssoEnabled, { timeout: 10_000 }).toBe(false);

    // The plan selector is a billing control, not a tenant one — a plain tenant
    // admin sees it read-only, matching the 403 asserted above.
    await expect(page.getByTestId(`org-plan-${org.id}`)).toBeDisabled();
  } finally {
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
