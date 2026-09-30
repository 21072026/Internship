import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, apiSession, submitSignInForm, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// One person, two worlds (#2590, docs/worlds.md).
//
// One e-mail address may hold an INTERNSHIP account (a row in the default org or
// an INTERNSHIP-vertical org) AND a MARKETING account (a row in a MARKETING-
// vertical org), each with its own password and data. The URL a person signs in
// on decides which of the two they get, and the session STAYS in that world.
//
// The browser in Playwright is always on localhost, so "arriving on the
// marketing site" is simulated with the forged proxy header the server reads
// first (`x-forwarded-host`), exactly as host-coherent-redirects.spec.ts does.
// Locally MARKETING_HOSTS is unset, so its default (MARKETING_HOST) is the
// marketing world and every other host is the internship world.

const INTERNSHIP_PW = 'InternWorld123!';
const MARKETING_PW = 'MarketWorld456!';

const orgIds: string[] = [];
const emails: string[] = [];

async function seedMarketingOrg(label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Worlds ${label} ${stamp}`, slug: `worlds-${label}-${stamp}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  return org;
}

/** One address, an ADMIN account in each world, different passwords. */
async function seedTwoWorlds(label: string) {
  const email = uniqueEmail(`worlds-${label}`);
  emails.push(email);
  const org = await seedMarketingOrg(label);
  const internship = await seedUser(email, INTERNSHIP_PW, 'ADMIN', 'Worlds Internship Admin');
  const marketing = await seedUser(email, MARKETING_PW, 'ADMIN', 'Worlds Marketing Admin', org.id);
  return { email, org, internship, marketing };
}

test.afterEach(async () => {
  for (const email of emails.splice(0)) {
    const users = await prisma.user.findMany({ where: { email }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.userConsent.deleteMany({ where: { userId: { in: ids } } });
    }
    await cleanupByEmail(email);
  }
  for (const id of orgIds.splice(0)) {
    await prisma.organization.delete({ where: { id } }).catch(() => {});
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test(
  'one e-mail, two accounts: the host you sign in on picks the account, and the two sessions stay independent',
  { tag: '@smoke' },
  async ({ playwright, baseURL }) => {
    const { email, org, internship, marketing } = await seedTwoWorlds('two');

    const internshipJar = await playwright.request.newContext({ baseURL });
    const marketingJar = await playwright.request.newContext({ baseURL });
    try {
      // Default host, the internship password.
      const a = await signInViaApi(internshipJar, email, INTERNSHIP_PW, { headers: freshIp('worlds-two-a') });
      expect(a.error, 'internship sign-in on the default host').toBeNull();
      const aSession = await apiSession(internshipJar);
      expect(aSession?.user.id).toBe(internship.id);
      expect(aSession?.user.orgId ?? null).not.toBe(org.id);

      // Marketing host, the marketing password.
      const b = await signInViaApi(marketingJar, email, MARKETING_PW, {
        host: MARKETING_HOST,
        headers: freshIp('worlds-two-b'),
      });
      expect(b.error, 'marketing sign-in on the marketing host').toBeNull();
      const bSession = await apiSession(marketingJar, MARKETING_HOST);
      expect(bSession?.user.id).toBe(marketing.id);
      expect(bSession?.user.orgId).toBe(org.id);

      // The jars did not bleed into each other.
      expect((await apiSession(internshipJar))?.user.id).toBe(internship.id);
      expect((await apiSession(marketingJar, MARKETING_HOST))?.user.id).toBe(marketing.id);
    } finally {
      await internshipJar.dispose();
      await marketingJar.dispose();
    }
  }
);

test(
  'a marketing-only account on the internship host: right password says WRONG_WORLD_MARKETING, wrong password stays generic',
  { tag: '@smoke' },
  async ({ request }) => {
    const email = uniqueEmail('worlds-mkt-only');
    emails.push(email);
    const org = await seedMarketingOrg('mktonly');
    await seedUser(email, MARKETING_PW, 'ADMIN', 'Worlds Marketing Only', org.id);

    const right = await signInViaApi(request, email, MARKETING_PW, { headers: freshIp('worlds-mkt-only-r') });
    expect(right.ok).toBe(false);
    expect(right.error).toBe('WRONG_WORLD_MARKETING');
    // No session was minted by the refusal.
    expect(await apiSession(request)).toBeNull();

    // A wrong password must not reveal that the account exists in the other world.
    const wrong = await signInViaApi(request, email, 'Definitely-Wrong-1!', { headers: freshIp('worlds-mkt-only-w') });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toBe('Invalid email or password');
    expect(wrong.url).not.toContain('WRONG_WORLD');
  }
);

test('an internship-only account on the marketing host: the mirror image', async ({ request }) => {
  const email = uniqueEmail('worlds-int-only');
  emails.push(email);
  await seedUser(email, INTERNSHIP_PW, 'ADMIN', 'Worlds Internship Only');

  const right = await signInViaApi(request, email, INTERNSHIP_PW, {
    host: MARKETING_HOST,
    headers: freshIp('worlds-int-only-r'),
  });
  expect(right.ok).toBe(false);
  expect(right.error).toBe('WRONG_WORLD_INTERNSHIP');
  expect(await apiSession(request, MARKETING_HOST)).toBeNull();

  const wrong = await signInViaApi(request, email, 'Definitely-Wrong-1!', {
    host: MARKETING_HOST,
    headers: freshIp('worlds-int-only-w'),
  });
  expect(wrong.error).toBe('Invalid email or password');
  expect(wrong.url).not.toContain('WRONG_WORLD');
});

test(
  'a session is bound to its world: an internship cookie replayed on the marketing host is no session',
  { tag: '@smoke' },
  async ({ request }) => {
    const email = uniqueEmail('worlds-bind');
    emails.push(email);
    const user = await seedUser(email, INTERNSHIP_PW, 'ADMIN', 'Worlds Bind Admin');

    const res = await signInViaApi(request, email, INTERNSHIP_PW, { headers: freshIp('worlds-bind') });
    expect(res.error).toBeNull();

    // Same jar, same cookie, other host: refused.
    expect(await apiSession(request, MARKETING_HOST)).toBeNull();
    // And the cookie is still good at home — the refusal did not destroy it.
    expect((await apiSession(request))?.user.id).toBe(user.id);
  }
);

test(
  'an invitation into the marketing org registers a second account for an address that already has an internship one',
  { tag: '@smoke' },
  async ({ request }) => {
    const { email, org, internship } = await seedTwoWorldsInternshipOnly('reg');
    const invite = async () => {
      const token = crypto.randomBytes(32).toString('hex');
      await prisma.invitationToken.create({
        data: { token, email, role: 'MENTEE', orgId: org.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      });
      return token;
    };
    const register = async (token: string) =>
      // On the marketing host: an invitation is only accepted in its own world.
      request.post('/api/register', {
        headers: { ...asHost(MARKETING_HOST), ...freshIp('worlds-register') },
        data: { token, email, password: MARKETING_PW, fullName: 'Worlds Registrant', consent: true },
      });

    const first = await register(await invite());
    expect(first.status(), await first.text()).toBe(201);

    const rows = await prisma.user.findMany({ where: { email }, select: { id: true, orgId: true } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === internship.id)?.orgId ?? null).toBeNull();
    expect(rows.find((r) => r.id !== internship.id)?.orgId).toBe(org.id);

    // The same world again — a duplicate, exactly as before.
    const second = await register(await invite());
    expect(second.status()).toBe(409);
    expect(await prisma.user.count({ where: { email } })).toBe(2);
  }
);

/** An internship-only address plus an (empty) marketing org to be invited into. */
async function seedTwoWorldsInternshipOnly(label: string) {
  const email = uniqueEmail(`worlds-${label}`);
  emails.push(email);
  const org = await seedMarketingOrg(label);
  const internship = await seedUser(email, INTERNSHIP_PW, 'ADMIN', 'Worlds Internship Admin');
  return { email, org, internship };
}

test('forgot-password mints its token for the account of the host it was asked on, and answers identically', async ({ request }) => {
  const { email, internship, marketing } = await seedTwoWorlds('forgot');
  const tokensOf = (userId: string) => prisma.passwordResetToken.count({ where: { userId } });

  const onMarketing = await request.post('/api/auth/forgot', {
    headers: { ...asHost(MARKETING_HOST), ...freshIp('worlds-forgot-m') },
    data: { email },
  });
  const marketingBody = await onMarketing.text();
  expect(onMarketing.status()).toBe(200);
  expect(await tokensOf(marketing.id)).toBe(1);
  expect(await tokensOf(internship.id)).toBe(0);

  const onDefault = await request.post('/api/auth/forgot', {
    headers: freshIp('worlds-forgot-d'),
    data: { email },
  });
  expect(onDefault.status()).toBe(200);
  expect(await onDefault.text()).toBe(marketingBody);
  expect(await tokensOf(internship.id)).toBe(1);
  // The default-host request did not add a second one for the marketing row.
  expect(await tokensOf(marketing.id)).toBe(1);

  const unknown = await request.post('/api/auth/forgot', {
    headers: freshIp('worlds-forgot-u'),
    data: { email: uniqueEmail('worlds-nobody') },
  });
  expect(unknown.status()).toBe(200);
  expect(await unknown.text()).toBe(marketingBody);
});

test('forgot-password on the marketing host never mails an internship-only account (no cross-world rescue)', async ({ request }) => {
  const { email, internship } = await seedTwoWorldsInternshipOnly('forgot-nocross');
  const tokensOf = (userId: string) => prisma.passwordResetToken.count({ where: { userId } });

  const onMarketing = await request.post('/api/auth/forgot', {
    headers: { ...asHost(MARKETING_HOST), ...freshIp('worlds-forgot-nocross-m') },
    data: { email },
  });
  expect(onMarketing.status()).toBe(200);
  // No SaleVali account for this address, so nothing is minted — and nothing is
  // mailed from the internship product either.
  expect(await tokensOf(internship.id)).toBe(0);

  const unknown = await request.post('/api/auth/forgot', {
    headers: { ...asHost(MARKETING_HOST), ...freshIp('worlds-forgot-nocross-u') },
    data: { email: uniqueEmail('worlds-nobody-m') },
  });
  expect(await unknown.text()).toBe(await onMarketing.text());
});

test('verification resend on the marketing host never mails an internship-only account; on its own host it does', async ({ request }) => {
  const email = uniqueEmail('worlds-resend');
  emails.push(email);
  const user = await seedUser(email, INTERNSHIP_PW, 'MENTEE', 'Worlds Resend Mentee');
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } });
  const tokensOf = () => prisma.emailVerificationToken.count({ where: { userId: user.id } });

  const onMarketing = await request.post('/api/auth/verify-email/resend', {
    headers: { ...asHost(MARKETING_HOST), ...freshIp('worlds-resend-m') },
    data: { email },
  });
  expect(onMarketing.status()).toBe(200);
  expect(await onMarketing.json()).toEqual({ ok: true });
  expect(await tokensOf()).toBe(0);

  const onDefault = await request.post('/api/auth/verify-email/resend', {
    headers: freshIp('worlds-resend-d'),
    data: { email },
  });
  expect(onDefault.status()).toBe(200);
  expect(await onDefault.text()).toBe(await onMarketing.text());
  expect(await tokensOf()).toBe(1);
});

test('an invitation of the other world is refused on this host like an unknown token, and nothing is created', async ({ request }) => {
  const email = uniqueEmail('worlds-reg-cross');
  emails.push(email);
  const org = await seedMarketingOrg('regcross');
  const mint = async (orgId: string | null) => {
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.invitationToken.create({
      data: { token, email, role: 'MENTEE', ...(orgId ? { orgId } : {}), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    return token;
  };
  const register = (token: string, headers: Record<string, string>) =>
    request.post('/api/register', {
      headers,
      data: { token, email, password: MARKETING_PW, fullName: 'Worlds Cross Registrant', consent: true },
    });
  const unknown = await register(crypto.randomBytes(32).toString('hex'), freshIp('worlds-reg-cross-u'));
  const unknownBody = await unknown.json();

  // A SaleVali invitation used on the internship host.
  const mktToken = await mint(org.id);
  const onDefault = await register(mktToken, freshIp('worlds-reg-cross-d'));
  expect(onDefault.status()).toBe(400);
  expect(await onDefault.json()).toEqual(unknownBody);
  // Opening the link here does not mark it as opened for its admin either.
  await request.post('/api/invite/opened', { headers: freshIp('worlds-reg-cross-o'), data: { token: mktToken } });
  const mktRow = await prisma.invitationToken.findUnique({ where: { token: mktToken } });
  expect(mktRow?.used).toBe(false);
  expect(mktRow?.openedAt ?? null).toBeNull();

  // …and the mirror: an Internship CRM invitation used on the marketing host.
  const intToken = await mint(null);
  const onMarketing = await register(intToken, { ...asHost(MARKETING_HOST), ...freshIp('worlds-reg-cross-m') });
  expect(onMarketing.status()).toBe(400);
  expect(await onMarketing.json()).toEqual(unknownBody);
  expect((await prisma.invitationToken.findUnique({ where: { token: intToken } }))?.used).toBe(false);

  expect(await prisma.user.count({ where: { email } })).toBe(0);
});

test('an SSO org code of the other world is refused on this host like an unknown one', async ({ request }) => {
  const ssoOrg = async (vertical: 'INTERNSHIP' | 'MARKETING') => {
    const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const org = await prisma.organization.create({
      data: {
        name: `Worlds SSO ${vertical} ${stamp}`,
        slug: `worlds-sso-${vertical.toLowerCase()}-${stamp}`,
        vertical,
        // Active SSO needs a complete SAML config on a plan that carries it
        // (isSsoActive); none of it is ever contacted by the refusal.
        plan: 'ENTERPRISE',
        ssoEnabled: true,
        ssoProvider: 'saml',
        ssoIssuer: 'https://idp.worlds.example/issuer',
        ssoEntryPoint: 'https://idp.worlds.example/sso',
        ssoCertificate: 'MIIC-not-a-real-certificate',
      },
    });
    orgIds.push(org.id);
    return org;
  };
  const login = async (slug: string, headers: Record<string, string> = {}) => {
    const res = await request.get(`/api/auth/sso/${slug}/login`, { headers, maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    return new URL(res.headers()['location']);
  };
  const internship = await ssoOrg('INTERNSHIP');
  const marketing = await ssoOrg('MARKETING');

  const unknownOnMarketing = await login('worlds-no-such-org', asHost(MARKETING_HOST));
  const crossOnMarketing = await login(internship.slug, asHost(MARKETING_HOST));
  expect(crossOnMarketing.hostname).toBe(MARKETING_HOST);
  expect(`${crossOnMarketing.pathname}${crossOnMarketing.search}`).toBe(
    `${unknownOnMarketing.pathname}${unknownOnMarketing.search}`
  );
  expect(crossOnMarketing.search).toBe('?error=sso_unavailable');

  const crossOnDefault = await login(marketing.slug);
  expect(crossOnDefault.hostname).not.toBe(MARKETING_HOST);
  expect(`${crossOnDefault.pathname}${crossOnDefault.search}`).toBe('/auth/signin?error=sso_unavailable');

  // Each code on its own world's host gets past the world check.
  expect((await login(internship.slug)).search).not.toContain('sso_unavailable');
  expect((await login(marketing.slug, asHost(MARKETING_HOST))).search).not.toContain('sso_unavailable');
});

test('the sign-in page on the marketing host answers an internship-only person in its own world, naming nothing else', async ({ page }) => {
  const email = uniqueEmail('worlds-ui');
  emails.push(email);
  await seedUser(email, INTERNSHIP_PW, 'ADMIN', 'Worlds UI Admin');

  await page.context().setExtraHTTPHeaders({ ...asHost(MARKETING_HOST), ...freshIp('worlds-ui') });
  await submitSignInForm(page, email, INTERNSHIP_PW);

  const box = page.getByTestId('signin-error');
  await expect(box).toHaveText('There is no SaleVali account with these details.', { timeout: 15_000 });
  // The other product is neither named nor linked, and the raw code is not printed.
  await expect(box).not.toContainText('Internship CRM');
  await expect(box.locator('a')).toHaveCount(0);
  await expect(page.getByTestId('wrong-world-link')).toHaveCount(0);
  await expect(page.getByText('WRONG_WORLD_INTERNSHIP')).toHaveCount(0);
});

test('the marketing register page names only its own product', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await gotoSettled(page, '/auth/register');
  const hint = page.getByTestId('separate-account-hint');
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await expect(hint).toContainText('SaleVali');
  await expect(hint).not.toContainText('Internship CRM');
});
