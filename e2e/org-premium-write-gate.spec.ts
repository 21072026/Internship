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
    expect(await lockedBrand.json()).toMatchObject({ code: 'feature_locked', feature: 'WHITE_LABEL' });

    const lockedSso = await patch(SAML);
    expect(lockedSso.status()).toBe(403);
    expect(await lockedSso.json()).toMatchObject({ code: 'feature_locked', feature: 'SSO_SAML' });

    // Nothing leaked past the gate — the refusal is before the write, not after.
    const untouched = await row();
    expect(untouched?.brandName).toBeNull();
    expect(untouched?.ssoProvider).toBeNull();
    expect(untouched?.ssoEnabled).toBe(false);

    // The plan itself is still editable: only the premium blocks are gated.
    expect((await patch({ plan: 'PRO' })).ok()).toBeTruthy();

    // --- PRO: branding unlocks, SSO does not ---------------------------------
    expect((await patch({ brandName: 'Gate Brand', brandColor: '#2563eb' })).ok()).toBeTruthy();
    expect((await row())?.brandName).toBe('Gate Brand');
    expect((await patch(SAML)).status()).toBe(403);

    // --- ENTERPRISE: SSO unlocks and goes active -----------------------------
    await plan('ENTERPRISE');
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

    // Editing is refused again while unentitled, and still changes nothing.
    expect((await patch({ brandName: 'Should Not Stick' })).status()).toBe(403);
    expect((await patch({ ssoEnabled: false })).status()).toBe(403);
    expect((await row())?.brandName).toBe('Gate Brand');

    // --- Re-upgrade: everything resumes with nothing re-entered --------------
    await plan('ENTERPRISE');
    expect((await listed()).sso.active).toBe(true);

    // The screen mirrors the gate (cosmetic — the 403 above is the control).
    await plan('FREE');
    await gotoSettled(page, '/admin/organizations');
    await page.getByTestId('brand-org-select').selectOption(org.id);
    await expect(page.getByTestId('branding-locked')).toBeVisible();
    await expect(page.getByTestId('brand-save')).toBeDisabled();
    await page.getByTestId('sso-org-select').selectOption(org.id);
    await expect(page.getByTestId('sso-locked')).toBeVisible();
    await expect(page.getByTestId('sso-save')).toBeDisabled();
  } finally {
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
