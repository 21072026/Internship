import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * Enforced SSO — every password door refused (#1950).
 *
 * WHY THIS EXISTS: "our tenant cannot sign in with a password" is a claim we
 * make in writing, and it is false the moment ONE of the six session-minting
 * paths still works. A claimed enforcement with an open back door is worse than
 * no claim, so each door gets its own assertion here, and each is proven by
 * calling the API or the NextAuth provider **directly** — never by checking
 * that some form is hidden, which proves nothing about the endpoint behind it.
 *
 * Every refusal is preceded or followed by a CONTROL that succeeds (the exempt
 * admin signs in with the same helper; the same reset token works for a user
 * outside the tenant). Without those, a harness broken in any way would look
 * exactly like working security.
 *
 * The tenant's IdP is fictional: nothing here completes an SSO login, and it
 * does not need to. `isSsoActive()` reads the stored config, and what is under
 * test is what happens to everything that is NOT the IdP. The live SAML round
 * trip is `e2e/sso-roundtrip.spec.ts`.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** A syntactically plausible PEM. Never verified here — no assertion is posted. */
const FAKE_CERT = `-----BEGIN CERTIFICATE-----\n${'MIIB'.repeat(20)}\n-----END CERTIFICATE-----`;

interface Tenant {
  orgId: string;
  slug: string;
  adminEmail: string;
  admin2Email: string;
  memberEmail: string;
  adminId: string;
  admin2Id: string;
  memberId: string;
}

const PASSWORD = 'EnforcedPass123!';

/**
 * An Enterprise tenant with a complete (but fictional) SAML config, enforcement
 * still OFF, and three members: two admins and one mentor.
 *
 * `plan: 'ENTERPRISE'` is load-bearing — since #1742 `isSsoActive()` also
 * requires the SSO_SAML entitlement, so a FREE tenant would refuse enforcement
 * for the wrong reason and every assertion below would pass by accident.
 */
async function seedEnforcedTenant(): Promise<Tenant> {
  const slug = `enforced-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: {
      name: `Enforced ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      ssoEnabled: true,
      ssoProvider: 'saml',
      ssoIssuer: `https://idp.example.com/${slug}`,
      ssoEntryPoint: 'https://idp.example.com/sso',
      ssoCertificate: FAKE_CERT,
      ssoEnforced: false,
    },
  });

  const adminEmail = uniqueEmail('ssoadmin');
  const admin2Email = uniqueEmail('ssoadmin2');
  const memberEmail = uniqueEmail('ssomember');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Enforced Admin');
  const admin2 = await seedUser(admin2Email, PASSWORD, 'ADMIN', 'Enforced Admin Two');
  const member = await seedUser(memberEmail, PASSWORD, 'MENTOR', 'Enforced Member');
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, admin2.id, member.id] } },
    data: { orgId: org.id },
  });

  return {
    orgId: org.id,
    slug,
    adminEmail,
    admin2Email,
    memberEmail,
    adminId: admin.id,
    admin2Id: admin2.id,
    memberId: member.id,
  };
}

async function dropTenant(t: Tenant | undefined) {
  if (!t) return;
  for (const email of [t.adminEmail, t.admin2Email, t.memberEmail]) {
    await cleanupByEmail(email).catch(() => {});
  }
  // Tolerated: a cleanup failure must not mask the assertion that actually
  // failed by throwing out of a finally block.
  await prisma.invitationToken.deleteMany({ where: { orgId: t.orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: t.orgId } }).catch(() => {});
}

/**
 * Call the NextAuth **credentials provider** itself, the way the sign-in page
 * does — CSRF token and all — and hand back the URL NextAuth wants the browser
 * to go to. A refusal carries `?error=<message>` in it.
 *
 * `json: 'true'` is what turns the 302 into a JSON body (next-auth/next), which
 * is exactly how the sign-in form's `signIn()` talks to it.
 */
async function credentialsSignIn(ctx: BrowserContext, email: string, password: string): Promise<string> {
  const csrf = await (await ctx.request.get('/api/auth/csrf')).json();
  const res = await ctx.request.post('/api/auth/callback/credentials', {
    form: { csrfToken: csrf.csrfToken, email, password, totp: '', json: 'true' },
    maxRedirects: 0,
  });
  const body = await res.text();
  try {
    return (JSON.parse(body) as { url?: string }).url ?? '';
  } catch {
    return res.headers()['location'] ?? '';
  }
}

/** The signed-in email per /api/auth/session (null when unauthenticated). */
async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

const REMEMBER_COOKIES = ['internship.remember-token', '__Secure-internship.remember-token'];

async function signInWithRemember(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.getByTestId('remember-me').check();
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle').catch(() => {});
}

test('an SSO-enforced tenant refuses every password door', { tag: '@smoke' }, async ({ browser }) => {
  let tenant: Tenant | undefined;
  const outsiderEmail = uniqueEmail('ssooutsider');
  const inviteeEmail = uniqueEmail('ssoinvitee');
  const adminCtx = await browser.newContext();
  const memberCtx = await browser.newContext();
  const anonCtx = await browser.newContext();

  try {
    tenant = await seedEnforcedTenant();
    // Outside the tenant entirely — the control for the reset door.
    const outsider = await seedUser(outsiderEmail, PASSWORD, 'MENTEE', 'Outsider');

    const adminPage = await adminCtx.newPage();
    const memberPage = await memberCtx.newPage();

    // ── Before enforcement: everything is normal ──────────────────────────
    // The member signs in AND is remembered, so the sweep below has a real
    // session and a real trusted device to end.
    await signInWithRemember(memberPage, tenant.memberEmail, PASSWORD);
    expect(await sessionEmail(memberPage)).toBe(tenant.memberEmail);
    const rememberCookie = (await memberCtx.cookies()).find((c) => REMEMBER_COOKIES.includes(c.name));
    expect(rememberCookie, 'the member should be remembered before the flip').toBeTruthy();

    await signInWithRemember(adminPage, tenant.adminEmail, PASSWORD);
    expect(await sessionEmail(adminPage)).toBe(tenant.adminEmail);

    // ── The anti-lockout interlock ────────────────────────────────────────
    // Enforcement with nobody exempt would leave this tenant one IdP outage
    // away from having no way back into its own account.
    const premature = await adminPage.request.patch('/api/admin/organizations', {
      data: { id: tenant.orgId, ssoEnforced: true },
    });
    expect(premature.status(), 'enforcement without a break-glass admin must be refused').toBe(400);
    expect((await premature.json()).blockers).toContain('NO_EXEMPT_ADMIN');
    expect((await prisma.organization.findUnique({ where: { id: tenant.orgId } }))!.ssoEnforced).toBe(false);

    // Grant the break-glass exemption to both admins: one is the tenant's way
    // back in, the second is the live non-exempt session used further down.
    for (const id of [tenant.adminId, tenant.admin2Id]) {
      const granted = await adminPage.request.post(`/api/admin/users/${id}/sso-exempt`, {
        data: { exempt: true },
      });
      expect(granted.ok()).toBeTruthy();
    }
    // Audited, at warning level — an exemption nobody can find is how a
    // temporary back door becomes a permanent one.
    expect(
      await prisma.auditLog.count({ where: { action: 'SSO_EXEMPT_GRANTED', targetId: tenant.adminId } })
    ).toBeGreaterThan(0);

    // A non-admin may never hold one.
    const refusedTarget = await adminPage.request.post(`/api/admin/users/${tenant.memberId}/sso-exempt`, {
      data: { exempt: true },
    });
    expect(refusedTarget.status(), 'only an active admin may hold an exemption').toBe(400);

    // ── The flip, and the sweep that must come with it ────────────────────
    const enforced = await adminPage.request.patch('/api/admin/organizations', {
      data: { id: tenant.orgId, ssoEnforced: true },
    });
    expect(enforced.ok()).toBeTruthy();
    expect((await enforced.json()).sessionsEnded).toBeGreaterThan(0);

    const sweptMember = await prisma.user.findUnique({ where: { id: tenant.memberId } });
    expect(sweptMember!.sessionsValidFrom, 'the sweep must stamp the cutoff').not.toBeNull();
    // BOTH halves of the hard rule: a cutoff without a device revocation means
    // the browser signs itself straight back in and nobody is signed out.
    expect(
      await prisma.trustedDevice.count({ where: { userId: tenant.memberId, revokedAt: null } })
    ).toBe(0);
    // The exempt admin keeps their session — an exemption signed out by the
    // very flip it exists to survive would be no exemption at all.
    expect((await prisma.user.findUnique({ where: { id: tenant.adminId } }))!.sessionsValidFrom).toBeNull();
    expect(await sessionEmail(adminPage)).toBe(tenant.adminEmail);
    // One audited row carrying the count.
    expect(
      await prisma.activityLog.count({ where: { action: 'sso.enforced', targetId: tenant.orgId } })
    ).toBe(1);
    // The member's already-open session is rejected on its next request.
    await expect.poll(async () => sessionEmail(memberPage), { timeout: 10_000 }).toBeNull();

    // ── DOOR 1 — password sign-in ─────────────────────────────────────────
    const refusedLogin = await credentialsSignIn(anonCtx, tenant.memberEmail, PASSWORD);
    expect(refusedLogin, 'the credentials provider must refuse with SSO_REQUIRED').toContain('SSO_REQUIRED');
    // CONTROL: the same call, same helper, for the exempt admin — no error.
    const exemptCtx = await browser.newContext();
    try {
      const allowed = await credentialsSignIn(exemptCtx, tenant.adminEmail, PASSWORD);
      expect(allowed, 'an exempt admin must still get in with a password').not.toContain('error=');
      const exemptPage = await exemptCtx.newPage();
      await exemptPage.goto('/admin');
      expect(await sessionEmail(exemptPage)).toBe(tenant.adminEmail);
    } finally {
      await exemptCtx.close();
    }

    // ── DOOR 2 — "remember me" silent re-authentication ───────────────────
    // The sweep already revoked this device; un-revoke it so the refusal below
    // can only be the enforcement check, never "your device was revoked".
    await prisma.trustedDevice.updateMany({
      where: { userId: tenant.memberId },
      data: { revokedAt: null },
    });
    const refreshed = await memberPage.request.post('/api/auth/remember/refresh');
    expect(refreshed.status(), 'a live remembered device must still be refused').toBe(401);
    expect((await refreshed.json()).error).toBe('sso_required');
    expect(await sessionEmail(memberPage)).toBeNull();

    // ── DOOR 3 — password reset completion (RESET) ────────────────────────
    const resetToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        token: resetToken,
        userId: tenant.memberId,
        purpose: 'RESET',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const peek = await anonCtx.request.get(`/api/auth/reset?token=${resetToken}`);
    expect((await peek.json()).code).toBe('sso_required');
    const refusedReset = await anonCtx.request.post('/api/auth/reset', {
      data: { token: resetToken, password: 'BrandNewPass123!' },
    });
    expect(refusedReset.status()).toBe(400);
    expect((await refusedReset.json()).code).toBe('sso_required');
    // CONTROL: the identical call for a user outside the tenant succeeds, so
    // the refusal above is about the tenant and not about the endpoint.
    const outsiderToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        token: outsiderToken,
        userId: outsider.id,
        purpose: 'RESET',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const okReset = await anonCtx.request.post('/api/auth/reset', {
      data: { token: outsiderToken, password: 'BrandNewPass123!' },
    });
    expect(okReset.ok(), 'the reset endpoint itself still works').toBeTruthy();

    // ── DOOR 4a — a SET_INITIAL link (the same endpoint, the other purpose) ─
    const initialToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        token: initialToken,
        userId: tenant.memberId,
        purpose: 'SET_INITIAL',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const refusedInitial = await anonCtx.request.post('/api/auth/reset', {
      data: { token: initialToken, password: 'BrandNewPass123!' },
    });
    expect(refusedInitial.status()).toBe(400);
    expect((await refusedInitial.json()).code).toBe('sso_required');

    // ── DOOR 4b — invitation registration (it sets a password) ────────────
    const inviteToken = crypto.randomBytes(32).toString('hex');
    await prisma.invitationToken.create({
      data: {
        token: inviteToken,
        email: inviteeEmail,
        role: 'MENTEE',
        orgId: tenant.orgId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const refusedRegister = await anonCtx.request.post('/api/register', {
      data: {
        token: inviteToken,
        email: inviteeEmail,
        password: 'BrandNewPass123!',
        fullName: 'Invited Into Enforced Tenant',
      },
    });
    expect(refusedRegister.status()).toBe(400);
    expect((await refusedRegister.json()).code).toBe('sso_required');
    expect(await prisma.user.count({ where: { email: inviteeEmail } })).toBe(0);

    // ── DOOR 5 — self-service password change ─────────────────────────────
    // Needs a LIVE session belonging to a NON-exempt user, which is what
    // someone who arrived through the IdP has. Reached here by signing the
    // second admin in while exempt and then withdrawing the exemption:
    // withdrawing one does not sweep sessions, so theirs survives.
    const admin2Ctx = await browser.newContext();
    try {
      const admin2Page = await admin2Ctx.newPage();
      const signedIn = await credentialsSignIn(admin2Ctx, tenant.admin2Email, PASSWORD);
      expect(signedIn).not.toContain('error=');
      await admin2Page.goto('/admin');
      expect(await sessionEmail(admin2Page)).toBe(tenant.admin2Email);

      const revoked = await adminPage.request.post(`/api/admin/users/${tenant.admin2Id}/sso-exempt`, {
        data: { exempt: false },
      });
      expect(revoked.ok()).toBeTruthy();
      expect(await sessionEmail(admin2Page), 'revoking an exemption does not sign anyone out').toBe(
        tenant.admin2Email
      );

      const hashBefore = (await prisma.user.findUnique({ where: { id: tenant.admin2Id } }))!.password;
      const refusedChange = await admin2Page.request.put('/api/account', {
        data: { currentPassword: PASSWORD, newPassword: 'BrandNewPass123!' },
      });
      expect(refusedChange.status()).toBe(400);
      expect((await refusedChange.json()).code).toBe('sso_required');
      // Refused BEFORE the write: the stored hash is untouched, so enforcement
      // never leaves a half-rotated credential behind.
      const hashAfter = (await prisma.user.findUnique({ where: { id: tenant.admin2Id } }))!.password;
      expect(hashAfter).toBe(hashBefore);

      // The last exemption cannot be withdrawn while enforcement is on — the
      // anti-lockout rule read from the other end.
      const lastOne = await adminPage.request.post(`/api/admin/users/${tenant.adminId}/sso-exempt`, {
        data: { exempt: false },
      });
      expect(lastOne.status()).toBe(400);
      expect((await lastOne.json()).code).toBe('last_sso_exemption');
    } finally {
      await admin2Ctx.close();
    }

    // ── Idempotence ───────────────────────────────────────────────────────
    // Re-saving an already-enforcing tenant must not sign everyone out again.
    const again = await adminPage.request.patch('/api/admin/organizations', {
      data: { id: tenant.orgId, ssoEnforced: true },
    });
    expect(again.ok()).toBeTruthy();
    expect((await again.json()).sessionsEnded).toBe(0);

    // ── And the way back ──────────────────────────────────────────────────
    const relaxed = await adminPage.request.patch('/api/admin/organizations', {
      data: { id: tenant.orgId, ssoEnforced: false },
    });
    expect(relaxed.ok()).toBeTruthy();
    const backIn = await browser.newContext();
    try {
      const url = await credentialsSignIn(backIn, tenant.memberEmail, PASSWORD);
      expect(url, 'password sign-in returns once enforcement is lifted').not.toContain('error=');
    } finally {
      await backIn.close();
    }
  } finally {
    await adminCtx.close();
    await memberCtx.close();
    await anonCtx.close();
    await cleanupByEmail(outsiderEmail).catch(() => {});
    await cleanupByEmail(inviteeEmail).catch(() => {});
    await dropTenant(tenant);
  }
});

// A tenant with no working SSO config must not be able to claim enforcement:
// the flag would be a promise nothing could keep, and password login is what
// its users would still be using.
test('enforcement is refused while the tenant\'s SSO is not active', async ({ browser }) => {
  const slug = `noidp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const adminEmail = uniqueEmail('noidpadmin');
  const context = await browser.newContext();
  let orgId: string | undefined;
  try {
    const org = await prisma.organization.create({
      data: { name: `No IdP ${slug}`, slug, plan: 'ENTERPRISE' },
    });
    orgId = org.id;
    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'No IdP Admin');
    await prisma.user.update({
      where: { id: admin.id },
      data: { orgId: org.id, ssoExempt: true },
    });

    const page = await context.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    const res = await page.request.patch('/api/admin/organizations', {
      data: { id: org.id, ssoEnforced: true },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).blockers).toContain('SSO_NOT_ACTIVE');
    expect((await prisma.organization.findUnique({ where: { id: org.id } }))!.ssoEnforced).toBe(false);
  } finally {
    await context.close();
    await cleanupByEmail(adminEmail).catch(() => {});
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  }
});
