import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { floodIp, freshIp } from './helpers/rateLimit';
import { gotoSettled } from './helpers/auth';
import { totp } from '../src/lib/totp';
import { LOGIN_LINK_TTL_MS, generateLoginLinkToken, hashLoginLinkToken } from '../src/lib/magicLinkToken';

// Magic-link sign-in (#1959). The link is a password-equivalent credential, so
// the tests here are the security boundary, not the UI: the request endpoint
// is an enumeration-safe 200 for everyone, the link signs in exactly once, and
// an enrolled authenticator is still asked for.
//
// Tokens are stored hashed, so a spec cannot read the mailed link back out of
// the table. The request half is verified through the row the API writes; the
// redemption half seeds a row through the SAME hash helper the app uses
// (src/lib/magicLinkToken.ts), which is the shape the mailed link has.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'MagicPass123!';

async function sessionEmail(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/auth/session');
  const body = (await res.json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

/** A link for `userId` in the shape the app mints: a hashed row, the raw value returned. */
async function seedLink(userId: string, opts: { expiresInMs?: number } = {}): Promise<{ raw: string; id: string }> {
  const raw = generateLoginLinkToken();
  const row = await prisma.loginLinkToken.create({
    data: {
      tokenHash: hashLoginLinkToken(raw),
      userId,
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? LOGIN_LINK_TTL_MS)),
    },
    select: { id: true },
  });
  return { raw, id: row.id };
}

async function requestLink(request: APIRequestContext, email: string, headers: Record<string, string>) {
  const res = await request.post('/api/auth/magic-link', { headers, data: { email } });
  return { status: res.status(), body: await res.text() };
}

async function dropSession(page: Page) {
  // The completion page's own full-page navigation to the role home can still
  // be in flight here and win the race against about:blank — the same shape
  // e2e/sso-roundtrip.spec.ts absorbs with gotoSettled.
  await gotoSettled(page, 'about:blank');
  await page.context().clearCookies({ name: /next-auth\.session-token/ });
}

test(
  'request → sign in once → a second use is refused',
  { tag: '@smoke' },
  async ({ page, request }) => {
    const email = uniqueEmail('magic');
    const user = await seedUser(email, PASSWORD, 'MENTEE', 'Magic Tester');

    try {
      // 1. The request endpoint: same status, same bytes, known or unknown.
      const known = await requestLink(request, email, freshIp('magic-known'));
      const unknown = await requestLink(request, uniqueEmail('magic-nobody'), freshIp('magic-unknown'));
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toBe(unknown.body);

      // 2. The known address got a row — hashed, unspent, fifteen minutes long.
      const minted = await prisma.loginLinkToken.findMany({ where: { userId: user.id } });
      expect(minted).toHaveLength(1);
      expect(minted[0].usedAt).toBeNull();
      expect(minted[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
      const life = minted[0].expiresAt.getTime() - minted[0].createdAt.getTime();
      expect(life).toBeGreaterThan(LOGIN_LINK_TTL_MS - 5_000);
      expect(life).toBeLessThanOrEqual(LOGIN_LINK_TTL_MS + 5_000);

      // 3. A second request retires the first link: only the newest mail works.
      await requestLink(request, email, freshIp('magic-again'));
      const afterSecond = await prisma.loginLinkToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0].usedAt).not.toBeNull();
      expect(afterSecond[1].usedAt).toBeNull();

      // 4. Redeem a link: it signs the user in and lands on the role home.
      // The session is read only AFTER that navigation: `page.request` shares
      // the browser's cookie jar, and a poll fired while the page is still
      // bootstrapping is one more cookie-less NextAuth request — which mints
      // its own CSRF cookie and can overwrite the one the page's sign-in POST
      // was built on (the race #2850's CI run exposed).
      const link = await seedLink(user.id);
      await page.goto(`/auth/magic/complete?token=${link.raw}`);
      await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 30_000 });
      expect(await sessionEmail(page.request)).toBe(email);
      const spent = await prisma.loginLinkToken.findUnique({ where: { id: link.id } });
      expect(spent!.usedAt).not.toBeNull();

      // 5. Audited — and the token is in no column of the row.
      const audit = await prisma.activityLog.findFirst({
        where: { action: 'auth.magic_link_used', actorId: user.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(link.raw);
      expect(JSON.stringify(audit)).not.toContain(hashLoginLinkToken(link.raw));

      // 6. Second use, from a browser with no session: inert.
      await dropSession(page);
      await page.goto(`/auth/magic/complete?token=${link.raw}`);
      await expect(page.getByTestId('magic-link-failed')).toBeVisible({ timeout: 30_000 });
      expect(await sessionEmail(page.request)).toBeNull();

      // 7. An expired link is refused the same way.
      const stale = await seedLink(user.id, { expiresInMs: -1_000 });
      await page.goto(`/auth/magic/complete?token=${stale.raw}`);
      await expect(page.getByTestId('magic-link-failed')).toBeVisible({ timeout: 30_000 });
      expect(await sessionEmail(page.request)).toBeNull();
      const staleRow = await prisma.loginLinkToken.findUnique({ where: { id: stale.id } });
      expect(staleRow!.usedAt).toBeNull();
    } finally {
      await cleanupByEmail(email);
    }
  }
);

test(
  'an enrolled authenticator is not bypassed: the link asks for the code, and only the code spends it',
  { tag: '@smoke' },
  async ({ page }) => {
    const email = uniqueEmail('magic-2fa');
    const secret = 'JBSWY3DPEHPK3PXP';
    const user = await seedUser(email, PASSWORD, 'MENTEE', 'Magic 2FA');
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorSecret: secret, lastTotpStep: null },
      select: { id: true },
    });

    try {
      const link = await seedLink(user.id);
      await page.goto(`/auth/magic/complete?token=${link.raw}`);

      // The link alone opens the code prompt — no session, and the link is
      // NOT spent by being asked.
      const form = page.getByTestId('magic-link-totp-form');
      await expect(form).toBeVisible({ timeout: 30_000 });
      expect(await sessionEmail(page.request)).toBeNull();
      expect((await prisma.loginLinkToken.findUnique({ where: { id: link.id } }))!.usedAt).toBeNull();

      // A wrong code is refused on the prompt; the link is still live.
      await form.getByLabel('Authenticator code').fill('000000');
      await form.locator('button[type="submit"]').click();
      await expect(form.getByRole('alert')).toBeVisible({ timeout: 15_000 });
      expect(await sessionEmail(page.request)).toBeNull();
      expect((await prisma.loginLinkToken.findUnique({ where: { id: link.id } }))!.usedAt).toBeNull();

      // The live code completes the sign-in and spends the link.
      await form.getByLabel('Authenticator code').fill(totp(secret));
      await form.locator('button[type="submit"]').click();
      await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 30_000 });
      expect(await sessionEmail(page.request)).toBe(email);
      expect((await prisma.loginLinkToken.findUnique({ where: { id: link.id } }))!.usedAt).not.toBeNull();
      // And the step is burned, exactly as a password sign-in burns it (#865).
      const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { lastTotpStep: true } });
      expect(fresh!.lastTotpStep).not.toBeNull();
    } finally {
      await cleanupByEmail(email);
    }
  }
);

test(
  'ineligible accounts get the same 200 and no link: inactive, unverified, pending, SSO-enforced',
  { tag: '@smoke' },
  async ({ request }) => {
    const inactive = uniqueEmail('magic-inactive');
    const unverified = uniqueEmail('magic-unverified');
    const pending = uniqueEmail('magic-pending');
    const enforced = uniqueEmail('magic-enforced');
    const slug = `magic-enf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const users = [
      await seedUser(inactive, PASSWORD, 'MENTEE', 'Inactive'),
      await seedUser(unverified, PASSWORD, 'MENTEE', 'Unverified'),
      await seedUser(pending, PASSWORD, 'MENTEE', 'Pending'),
      await seedUser(enforced, PASSWORD, 'MENTOR', 'Enforced'),
    ];
    // An Enterprise tenant with a complete SAML config and enforcement ON — the
    // same shape e2e/sso-enforced.spec.ts seeds (`plan` is load-bearing: since
    // #1742 isSsoActive() also needs the SSO_SAML entitlement).
    const org = await prisma.organization.create({
      data: {
        name: `Magic enforced ${slug}`,
        slug,
        plan: 'ENTERPRISE',
        ssoEnabled: true,
        ssoProvider: 'saml',
        ssoIssuer: `https://idp.example.com/${slug}`,
        ssoEntryPoint: 'https://idp.example.com/sso',
        ssoCertificate: `-----BEGIN CERTIFICATE-----\n${'MIIB'.repeat(20)}\n-----END CERTIFICATE-----`,
        ssoEnforced: true,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: users[0].id }, data: { isActive: false }, select: { id: true } });
    await prisma.user.update({ where: { id: users[1].id }, data: { emailVerified: false }, select: { id: true } });
    await prisma.user.update({ where: { id: users[2].id }, data: { isActive: false, pendingApproval: true }, select: { id: true } });
    await prisma.user.update({ where: { id: users[3].id }, data: { orgId: org.id }, select: { id: true } });

    try {
      const control = await requestLink(request, uniqueEmail('magic-nobody'), freshIp('magic-control'));
      for (const email of [inactive, unverified, pending, enforced]) {
        const r = await requestLink(request, email, freshIp(`magic-${email}`));
        expect(r.status).toBe(200);
        expect(r.body).toBe(control.body);
      }
      const rows = await prisma.loginLinkToken.count({ where: { userId: { in: users.map((u) => u.id) } } });
      expect(rows).toBe(0);
    } finally {
      for (const email of [inactive, unverified, pending, enforced]) await cleanupByEmail(email);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  }
);

test('the request endpoint is rate-limited per address and per IP', async ({ request }) => {
  const email = uniqueEmail('magic-rl');
  try {
    // Per address: five from five different machines, the sixth is refused
    // whichever machine it comes from.
    for (let i = 0; i < 5; i++) {
      expect((await requestLink(request, email, freshIp(`magic-rl-${i}`))).status).toBe(200);
    }
    expect((await requestLink(request, email, freshIp('magic-rl-6'))).status).toBe(429);

    // Per IP: one machine, five different addresses, the sixth is refused.
    const ip = floodIp('magic-rl-ip');
    for (let i = 0; i < 5; i++) {
      expect((await requestLink(request, uniqueEmail(`magic-rl-ip-${i}`), ip)).status).toBe(200);
    }
    expect((await requestLink(request, uniqueEmail('magic-rl-ip-6'), ip)).status).toBe(429);
  } finally {
    await cleanupByEmail(email);
  }
});
