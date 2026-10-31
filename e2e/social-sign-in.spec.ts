import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

/**
 * Social sign-in (#1962), end to end against the stub IdP: Google, Microsoft
 * and LinkedIn are all pointed at its OIDC half (playwright.config.ts), so the
 * provider redirect, the code exchange, the ID-token verification and the
 * linking rule run for real with no external network. The pure rule is
 * unit-tested in scripts/test/social-sign-in.test.mjs; this proves the chain
 * and the boundaries only the running app can:
 *   • an UNVERIFIED provider email never links and never creates an account;
 *   • a returning subject lands on the same account even after an email change;
 *   • the session comes from the `magic` door, so an enrolled authenticator is
 *     still asked for and an SSO-enforced tenant's user is refused;
 *   • the last way in cannot be unlinked.
 */

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const PASSWORD = 'Social123!';

test.beforeEach(() => {
  test.skip(!!process.env.BASE_URL, 'the stub IdP only runs under the local webServer');
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

interface NextIdentity { email: string; name?: string; sub?: string; emailVerified?: boolean | null }

/** Login route → stub authorize → our callback. Returns where the callback sends the browser. */
async function socialRoundTrip(request: APIRequestContext, provider: string, identity: NextIdentity, opts: { link?: boolean } = {}) {
  expect((await request.post(`${MOCK}/oidc/next`, { data: identity })).ok()).toBe(true);
  const login = await request.get(`/api/auth/social/${provider}/login${opts.link ? '?link=1' : ''}`, { maxRedirects: 0 });
  expect(login.status(), 'the login route redirects to the provider').toBeGreaterThanOrEqual(300);
  const authorize = await request.get(login.headers()['location'], { maxRedirects: 0 });
  const callbackUrl = new URL(authorize.headers()['location']);
  const callback = await request.get(callbackUrl.pathname + callbackUrl.search, { maxRedirects: 0 });
  expect(callback.status()).toBe(303);
  return callback.headers()['location'];
}

/** Redeem the sign-in link the callback minted through the `magic` provider; the NextAuth error, or null. */
async function redeem(request: APIRequestContext, location: string, totp = ''): Promise<string | null> {
  const token = new URL(location, 'http://x.invalid').searchParams.get('token');
  expect(token, `expected a sign-in link, got ${location}`).toBeTruthy();
  const csrf = await (await request.get('/api/auth/csrf')).json();
  const res = await request.post('/api/auth/callback/magic', { form: { csrfToken: csrf.csrfToken, grant: token!, totp, json: 'true' }, maxRedirects: 0 });
  const body = await res.text();
  let target = res.headers()['location'] ?? '';
  try {
    target = (JSON.parse(body) as { url?: string }).url ?? target;
  } catch {
    /* a redirect, not JSON */
  }
  return new URL(target, 'http://x.invalid').searchParams.get('error');
}

/** The consent step a NEW account goes through: POST the answer, get where the browser goes next. */
async function consent(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/social/consent', { data: { consent: true } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).redirect as string;
}

async function sessionEmail(request: APIRequestContext): Promise<string | null> {
  const body = (await (await request.get('/api/auth/session')).json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

test('social sign-in: Google, Microsoft and LinkedIn each sign a verified identity in; unknown providers do not exist', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const emails: string[] = [];
  try {
    for (const provider of ['google', 'microsoft', 'linkedin']) {
      const ctx = await playwright.request.newContext({ baseURL });
      const email = uniqueEmail(`social-${provider}`).toLowerCase();
      emails.push(email);
      const location = await socialRoundTrip(ctx, provider, { email, name: `Social ${provider}`, sub: `${provider}|${crypto.randomUUID()}` });
      // A NEW account asks for consent first — nothing exists yet.
      expect(location).toContain('/auth/social/consent');
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      if (provider === 'google') {
        const declined = await ctx.post('/api/auth/social/consent', { data: { consent: false } });
        expect(declined.status()).toBe(400);
        expect(await prisma.user.count({ where: { email } }), 'no consent, no account').toBe(0);
      }
      const next = await consent(ctx);
      expect(next).toContain('/auth/magic/complete?token=');
      expect(await redeem(ctx, next)).toBeNull();
      expect(await sessionEmail(ctx)).toBe(email);
      const user = await prisma.user.findFirstOrThrow({ where: { email }, include: { userIdentities: true } });
      expect(user.role).toBe('MENTEE');
      expect(user.emailVerified).toBe(true);
      expect(user.consentAt).toBeTruthy();
      expect(await prisma.userConsent.count({ where: { userId: user.id, type: 'PRIVACY_POLICY' } })).toBe(1);
      // The ticket is single-use: a second POST creates nothing more.
      expect((await ctx.post('/api/auth/social/consent', { data: { consent: true } })).status()).toBe(400);
      expect(user.userIdentities.map((i) => i.provider)).toEqual([provider]);
      await ctx.dispose();
    }
    const page = await (await playwright.request.newContext({ baseURL })).get('/auth/signin');
    const html = await page.text();
    for (const p of ['google', 'microsoft', 'linkedin']) expect(html).toContain(`data-testid="social-sign-in-${p}"`);
    const unknown = await (await playwright.request.newContext({ baseURL })).get('/api/auth/social/facebook/login', { maxRedirects: 0 });
    expect(unknown.status()).toBe(404);
  } finally {
    for (const e of emails) await cleanupByEmail(e);
  }
});

test('social sign-in: an UNVERIFIED provider email never links to an account and never creates one', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const existing = uniqueEmail('social-unverified-existing').toLowerCase();
  const stranger = uniqueEmail('social-unverified-new').toLowerCase();
  await seedUser(existing, PASSWORD, 'MENTEE', 'Has A Password');
  try {
    for (const emailVerified of [false, null]) {
      const ctx = await playwright.request.newContext({ baseURL });
      const location = await socialRoundTrip(ctx, 'google', { email: existing, emailVerified, sub: `google|${crypto.randomUUID()}` });
      expect(location).toContain('/auth/signin?error=social_unverified_email');
      expect(await sessionEmail(ctx)).toBeNull();
      await ctx.dispose();
    }
    const owner = await prisma.user.findFirstOrThrow({ where: { email: existing }, include: { userIdentities: true } });
    expect(owner.userIdentities, 'nothing was linked to the existing account').toHaveLength(0);

    const ctx = await playwright.request.newContext({ baseURL });
    expect(await socialRoundTrip(ctx, 'linkedin', { email: stranger, emailVerified: false })).toContain('error=social_unverified_email');
    expect(await prisma.user.count({ where: { email: stranger } }), 'no account was created').toBe(0);
    await ctx.dispose();
  } finally {
    await cleanupByEmail(existing);
    await cleanupByEmail(stranger);
  }
});

test('social sign-in: a verified match links; the subject keeps the account through an email change; 2FA and enforced SSO still apply', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const email = uniqueEmail('social-link').toLowerCase();
  const twoFa = uniqueEmail('social-2fa').toLowerCase();
  const enforcedEmail = uniqueEmail('social-enforced').toLowerCase();
  const sub = `google|${crypto.randomUUID()}`;
  const idp = await (await fetch(`${MOCK}/__state`)).json();
  const slug = `soc-enf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Enforced ${slug}`, slug, plan: 'ENTERPRISE', ssoEnabled: true, ssoEnforced: true, ssoProvider: 'saml', ssoIssuer: idp.samlIssuer, ssoEntryPoint: idp.samlSsoUrl, ssoCertificate: idp.samlCertificate },
  });
  const user = await seedUser(email, PASSWORD, 'MENTOR', 'Linked Mentor');
  try {
    const ctx = await playwright.request.newContext({ baseURL });
    const first = await socialRoundTrip(ctx, 'google', { email, sub });
    expect(await redeem(ctx, first)).toBeNull();
    expect(await sessionEmail(ctx)).toBe(email);
    const identity = await prisma.userIdentity.findFirstOrThrow({ where: { userId: user.id } });
    expect(identity.provider).toBe('google');
    expect(await prisma.activityLog.count({ where: { action: 'auth.identity_linked', targetId: user.id } })).toBe(1);
    await ctx.dispose();

    // The provider's address changed; the SUBJECT did not — same account.
    const ctx2 = await playwright.request.newContext({ baseURL });
    const again = await socialRoundTrip(ctx2, 'google', { email: `renamed-${email}`, sub, emailVerified: false });
    expect(await redeem(ctx2, again)).toBeNull();
    expect(await sessionEmail(ctx2)).toBe(email);
    await ctx2.dispose();

    // An enrolled authenticator is still asked for: the link is not a bypass.
    const tf = await seedUser(twoFa, PASSWORD, 'MENTEE', 'Two Factor');
    await prisma.user.update({ where: { id: tf.id }, data: { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' } });
    const ctx3 = await playwright.request.newContext({ baseURL });
    const tfLoc = await socialRoundTrip(ctx3, 'google', { email: twoFa });
    expect(await redeem(ctx3, tfLoc)).toBe('2FA_REQUIRED');
    expect(await sessionEmail(ctx3)).toBeNull();
    await ctx3.dispose();

    // A user of an SSO-enforced tenant signs in through its IdP only.
    await seedUser(enforcedEmail, PASSWORD, 'MENTEE', 'Enforced User', org.id);
    const ctx4 = await playwright.request.newContext({ baseURL });
    expect(await socialRoundTrip(ctx4, 'google', { email: enforcedEmail })).toContain('error=social_sso_required');
    expect(await prisma.userIdentity.count({ where: { email: enforcedEmail } })).toBe(0);
    await ctx4.dispose();
  } finally {
    for (const e of [email, twoFa, enforcedEmail]) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('social sign-in: identities are listed and unlinkable, but never the last way in', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const email = uniqueEmail('social-only').toLowerCase();
  try {
    const ctx = await playwright.request.newContext({ baseURL });
    expect(await socialRoundTrip(ctx, 'google', { email, sub: `google|${crypto.randomUUID()}` })).toContain('/auth/social/consent');
    expect(await redeem(ctx, await consent(ctx))).toBeNull();
    let listed = await (await ctx.get('/api/account/identities')).json();
    expect(listed.hasPassword).toBe(false);
    expect(listed.identities).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('google|'); // the subject is never returned
    expect(JSON.stringify(listed)).not.toContain('e2e-social-secret');

    // The only way in: refused by the server.
    const last = await ctx.delete(`/api/account/identities?id=${listed.identities[0].id}`);
    expect(last.status()).toBe(409);
    expect((await last.json()).code).toBe('last_sign_in_method');

    // Connect a second provider from the signed-in session, then one may go.
    const linked = await socialRoundTrip(ctx, 'linkedin', { email: `other-${email}`, emailVerified: false, sub: `linkedin|${crypto.randomUUID()}` }, { link: true });
    expect(linked).toContain('/account?linked=linkedin');
    listed = await (await ctx.get('/api/account/identities')).json();
    expect(listed.identities.map((i: { provider: string }) => i.provider).sort()).toEqual(['google', 'linkedin']);
    expect((await ctx.delete(`/api/account/identities?id=${listed.identities[0].id}`)).status()).toBe(200);
    await ctx.dispose();
  } finally {
    await cleanupByEmail(email);
  }
});
