import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';
import { SSO_IMPLEMENTED_PROVIDERS, SSO_OIDC_UNSUPPORTED, validateSsoConfig } from '../src/lib/sso';

/**
 * Enterprise SSO, end to end against a stub IdP (#1936).
 *
 * WHY THIS EXISTS: `e2e/sso-saml-mapping.spec.ts` and `e2e/sso-provisioning.spec.ts`
 * test pure functions, and the only end-to-end recipe was a human clicking
 * through the public mocksaml.com — so nothing in CI ever drove
 * login → IdP → ACS → session, and `docs/security-audit-playbook.md` §7 listed
 * live SAML SSO as never examined. `e2e/support/idp-mock.mjs` (started by
 * `playwright.config.ts`, the same shape as the Google Calendar stub) signs real
 * assertions with a key pair generated at start-up, so the app's own
 * verification path runs for real — and can be handed assertions that are
 * deliberately wrong in exactly one way each.
 *
 * The negatives matter more than the happy path: a harness that only proves
 * login works would have let every one of them regress silently.
 *
 * WHAT THIS DOES NOT PROVE: that a real Entra ID / Okta / Google Workspace
 * tenant emits what we accept. See the "what the stub cannot prove" sections of
 * docs/sso-saml.md and docs/sso-oidc.md.
 */

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;

interface IdpState {
  samlIssuer: string;
  samlSsoUrl: string;
  samlCertificate: string;
  rogueCertificate: string;
  oidcIssuer: string;
  oidcDiscoveryUrl: string;
}

let idp: IdpState;

test.beforeEach(() => {
  test.skip(
    !!process.env.BASE_URL,
    'the stub IdP is started by playwright.config.ts webServer, which a BASE_URL run does not start'
  );
});

test.beforeAll(async () => {
  // A BASE_URL run has no stub to ask (the whole webServer array is skipped),
  // and every test in this file is skipped above — so don't fail here first.
  if (process.env.BASE_URL) return;
  // Plain fetch, not the `request` fixture: `request` is test-scoped and cannot
  // be used from beforeAll.
  idp = (await (await fetch(`${MOCK}/__state`)).json()) as IdpState;
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A tenant whose IdP is the stub. Written straight to the DB rather than through
 * `PATCH /api/admin/organizations`, because `validateSsoConfig()` (rightly)
 * refuses a non-https entry point and the stub cannot serve TLS. Loosening that
 * check to make a test pass is the one thing this harness must not do — the
 * check IS the feature — so the write boundary stays untouched and the row is
 * seeded behind it. `plan: 'ENTERPRISE'` is load-bearing: since #1742
 * `isSsoActive()` also requires the SSO_SAML entitlement, and a FREE tenant
 * would fail the round trip for the wrong reason.
 */
async function seedSsoOrg(
  prefix: string,
  opts: {
    provider?: 'saml' | 'oidc';
    mode?: string;
    email?: string;
    name?: string;
    entryPoint?: string;
    certificate?: string | null;
    /** Organization.vertical — a MARKETING org's sign-in lives on the marketing host (#2590). */
    vertical?: string;
  } = {}
) {
  const slug = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const provider = opts.provider ?? 'saml';
  const query = new URLSearchParams();
  if (opts.mode) query.set('mode', opts.mode);
  if (opts.email) query.set('email', opts.email);
  if (opts.name) query.set('name', opts.name);
  const base = opts.entryPoint ?? (provider === 'saml' ? idp.samlSsoUrl : `${idp.oidcIssuer}/authorize`);
  const org = await prisma.organization.create({
    data: {
      name: `SSO ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      ssoEnabled: true,
      ...(opts.vertical ? { vertical: opts.vertical } : {}),
      ssoProvider: provider,
      ssoIssuer: provider === 'saml' ? idp.samlIssuer : idp.oidcIssuer,
      ssoEntryPoint: query.toString() ? `${base}?${query}` : base,
      ssoCertificate:
        opts.certificate === undefined ? (provider === 'saml' ? idp.samlCertificate : null) : opts.certificate,
    },
  });
  return { org, slug };
}

async function dropSsoOrg(orgId: string, emails: string[]) {
  const users = await prisma.user.findMany({ where: { orgId }, select: { id: true, email: true } });
  await prisma.ssoLoginGrant.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  for (const email of new Set([...emails, ...users.map((u) => u.email)])) {
    await cleanupByEmail(email);
  }
  // Tolerated: a cleanup failure must not mask the assertion that actually
  // failed by throwing out of a finally block.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
}

/**
 * Ask the app for its own AuthnRequest and hand it back to the stub, instead of
 * telling the stub what the audience and ACS URL are. That way the assertion is
 * addressed to whatever the app asked for, so a rejection below can only be the
 * defect the case is named after — never a NEXTAUTH_URL/baseURL mismatch that
 * would make every negative pass for the wrong reason.
 */
async function captureAuthnRequest(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.get(`/api/auth/sso/${slug}/login`, { maxRedirects: 0 });
  expect(res.status(), 'the login route should redirect to the IdP').toBeGreaterThanOrEqual(300);
  expect(res.status()).toBeLessThan(400);
  const location = new URL(res.headers()['location']);
  expect(location.origin).toBe(MOCK);
  const samlRequest = location.searchParams.get('SAMLRequest');
  expect(samlRequest, 'the redirect should carry a SAMLRequest').toBeTruthy();
  return samlRequest!;
}

async function mintAssertion(
  request: APIRequestContext,
  body: { samlRequest: string; mode?: string; email?: string; name?: string }
): Promise<string> {
  const res = await request.post(`${MOCK}/saml/mint`, { data: body });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).SAMLResponse as string;
}

async function sessionEmail(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/auth/session');
  const body = (await res.json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

// --- SAML -------------------------------------------------------------------

test(
  'SAML: a signed assertion from the tenant IdP JIT-provisions the user and issues a session',
  { tag: '@smoke' },
  async ({ page }) => {
    const email = uniqueEmail('sso-roundtrip').toLowerCase();
    const { org, slug } = await seedSsoOrg('sso-rt', { email, name: 'Sso Roundtrip' });
    try {
      // The whole SP-initiated flow, in a browser: /auth/sso → login route →
      // stub IdP → HTTP-POST binding back to our ACS → /auth/sso/complete →
      // the `sso` NextAuth provider consumes the grant.
      await page.goto('/auth/sso');
      await page.getByTestId('sso-slug-input').fill(slug);
      await page.getByTestId('sso-continue').click();

      await expect
        .poll(() => sessionEmail(page.request), {
          timeout: 30_000,
          message: 'the SAML round trip should end in a session for the asserted identity',
        })
        .toBe(email);

      const user = await prisma.user.findFirst({ where: { email } });
      expect(user, 'the assertion should have JIT-provisioned a user').toBeTruthy();
      expect(user!.orgId).toBe(org.id);
      expect(user!.role).toBe('MENTEE'); // least privilege by default
      expect(user!.emailVerified).toBe(true); // the IdP vouched for the address
      expect(user!.fullName).toBe('Sso Roundtrip'); // firstName + lastName claims
      // No local password login for an SSO account.
      expect(user!.password).toBe('!sso-no-login');

      // The ACS minted exactly one grant and it was consumed.
      const grants = await prisma.ssoLoginGrant.findMany({ where: { userId: user!.id } });
      expect(grants).toHaveLength(1);
      expect(grants[0].used).toBe(true);
    } finally {
      await dropSsoOrg(org.id, [email]);
    }
  }
);

test('SAML: a sign-in started on the marketing host finishes there — login RelayState, IdP echo, ACS success (#2494)', async ({
  request,
}) => {
  const MARKETING = 'marketing.bcsit-gmbh.de';
  const AS_MARKETING = { 'x-forwarded-host': MARKETING, 'x-forwarded-proto': 'https' };
  const email = uniqueEmail('sso-mkt').toLowerCase();
  // A MARKETING org: under #2590 the ACS honours a started-on origin only when
  // it is in the organization's own world (an internship grant handed to the
  // marketing host would be burned and refused by the `sso` provider).
  const { org, slug } = await seedSsoOrg('sso-mkt', { email, name: 'Sso Marketing', vertical: 'MARKETING' });
  try {
    // 1. The login route, as the marketing host: the redirect to the stub IdP
    //    carries the starting origin as RelayState.
    const login = await request.get(`/api/auth/sso/${slug}/login`, { headers: AS_MARKETING, maxRedirects: 0 });
    expect(login.status()).toBeGreaterThanOrEqual(300);
    expect(login.status()).toBeLessThan(400);
    const toIdp = new URL(login.headers()['location']);
    expect(toIdp.origin).toBe(MOCK);
    expect(toIdp.searchParams.get('RelayState')).toBe(`https://${MARKETING}`);

    // 2. The stub IdP's redirect binding — the real page a browser would get,
    //    with the auto-POST form that echoes RelayState back.
    const page = await (await request.get(toIdp.toString())).text();
    const field = (name: string) => {
      const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(page);
      return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
    };
    const SAMLResponse = field('SAMLResponse');
    const RelayState = field('RelayState');
    expect(SAMLResponse, 'the IdP page should carry a SAMLResponse').toBeTruthy();
    expect(RelayState, 'the IdP should echo RelayState').toBe(`https://${MARKETING}`);

    // 3. The ACS (the registered host, no forged header — that is where the IdP
    //    posts): a valid assertion, and the browser is sent back to the
    //    marketing host to complete the sign-in.
    const acs = await request.post(`/api/auth/sso/${slug}/acs`, { form: { SAMLResponse: SAMLResponse!, RelayState: RelayState! }, maxRedirects: 0 });
    expect(acs.status()).toBe(303);
    const done = new URL(acs.headers()['location']);
    expect(done.origin).toBe(`https://${MARKETING}`);
    expect(done.pathname).toBe('/auth/sso/complete');
    expect(done.searchParams.get('token')).toBeTruthy();
    expect(await prisma.user.count({ where: { email, orgId: org.id } })).toBe(1);
  } finally {
    await dropSsoOrg(org.id, [email]);
  }
});

test('SAML: an assertion signed by an untrusted key lands on the sign-in error page, not a session', async ({
  page,
}) => {
  const email = uniqueEmail('sso-wrongkey').toLowerCase();
  const { org, slug } = await seedSsoOrg('sso-wk', { mode: 'wrong-key', email, name: 'Wrong Key' });
  try {
    await page.goto('/auth/sso');
    await page.getByTestId('sso-slug-input').fill(slug);
    await page.getByTestId('sso-continue').click();

    // The user-visible outcome matters as much as the refusal: an error page,
    // not a 500 and not a half-signed-in state.
    await page.waitForURL(/\/auth\/signin\?error=sso_failed/, { timeout: 30_000 });
    expect(await sessionEmail(page.request)).toBeNull();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  } finally {
    await dropSsoOrg(org.id, [email]);
  }
});

test('SAML: the ACS refuses assertions that are unsigned, tampered, expired or mis-audienced', async ({
  request,
}) => {
  const { org, slug } = await seedSsoOrg('sso-neg');
  const emails: string[] = [];
  try {
    // Control first. The same machinery, one flag apart, must be ACCEPTED —
    // otherwise every rejection below could be a broken harness rather than a
    // working check.
    const controlEmail = uniqueEmail('sso-neg-control').toLowerCase();
    emails.push(controlEmail);
    const controlResponse = await mintAssertion(request, {
      samlRequest: await captureAuthnRequest(request, slug),
      mode: 'ok',
      email: controlEmail,
      name: 'Neg Control',
    });
    const control = await request.post(`/api/auth/sso/${slug}/acs`, {
      form: { SAMLResponse: controlResponse },
      maxRedirects: 0,
    });
    expect(control.status()).toBe(303);
    expect(control.headers()['location']).toContain('/auth/sso/complete?token=');
    expect(await prisma.user.count({ where: { email: controlEmail } })).toBe(1);

    const refused = [
      // A correctly formed assertion from an issuer the tenant never trusted —
      // the attack the signature check exists to stop.
      'wrong-key',
      // A valid signature with one byte of SignatureValue flipped.
      'bad-signature',
      // No <Signature> at all: wantAssertionsSigned must not be optional.
      'unsigned',
      // Conditions/SubjectConfirmationData NotOnOrAfter in the past, well
      // outside the 5s accepted clock skew.
      'expired',
      // AudienceRestriction naming another SP: a replay of a genuine assertion
      // issued for a different service provider.
      'wrong-audience',
    ];

    for (const mode of refused) {
      const email = uniqueEmail(`sso-neg-${mode}`).toLowerCase();
      emails.push(email);
      const SAMLResponse = await mintAssertion(request, {
        samlRequest: await captureAuthnRequest(request, slug),
        mode,
        email,
        name: 'Neg Case',
      });
      const res = await request.post(`/api/auth/sso/${slug}/acs`, {
        form: { SAMLResponse },
        maxRedirects: 0,
      });
      expect(res.status(), `${mode} should be a redirect, never a 500`).toBe(303);
      expect(res.headers()['location'], `${mode} should land on the sign-in error page`).toContain(
        '/auth/signin?error=sso_failed'
      );
      expect(await prisma.user.count({ where: { email } }), `${mode} must not provision a user`).toBe(0);
    }
  } finally {
    await dropSsoOrg(org.id, emails);
  }
});

test('SAML: a consumed SsoLoginGrant cannot be replayed into a second session', async ({ page, request }) => {
  const email = uniqueEmail('sso-replay').toLowerCase();
  const { org, slug } = await seedSsoOrg('sso-rp');
  try {
    // Mint a grant without a browser, so the first use below is the only one.
    const SAMLResponse = await mintAssertion(request, {
      samlRequest: await captureAuthnRequest(request, slug),
      mode: 'ok',
      email,
      name: 'Sso Replay',
    });
    const acs = await request.post(`/api/auth/sso/${slug}/acs`, {
      form: { SAMLResponse },
      maxRedirects: 0,
    });
    expect(acs.status()).toBe(303);
    const token = new URL(acs.headers()['location']).searchParams.get('token');
    expect(token).toBeTruthy();

    // First use: the grant establishes a session.
    await page.goto(`/auth/sso/complete?token=${token}`);
    await expect.poll(() => sessionEmail(page.request), { timeout: 30_000 }).toBe(email);

    // Second use, from a browser with no session: a leaked or logged grant URL
    // must be inert. Only the session cookie is dropped — a blanket
    // clearCookies() would also drop the seeded cookie-consent state.
    // `/auth/sso/complete` redirects client-side once the session poll above
    // observes it, so a plain goto here can race that still-in-flight
    // navigation ("interrupted by another navigation to /portal") — the same
    // shape gotoSettled exists to absorb elsewhere (see its doc comment).
    await gotoSettled(page, 'about:blank');
    await page.context().clearCookies({ name: /next-auth\.session-token/ });
    await page.goto(`/auth/sso/complete?token=${token}`);
    await page.waitForURL(/\/(auth\/signin|auth\/error|api\/auth\/error)/, { timeout: 30_000 });
    expect(await sessionEmail(page.request)).toBeNull();

    const user = await prisma.user.findFirst({ where: { email } });
    const grants = await prisma.ssoLoginGrant.findMany({ where: { userId: user!.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0].used).toBe(true);
  } finally {
    await dropSsoOrg(org.id, [email]);
  }
});

test('SAML: concurrent redemptions of one grant mint exactly one session (#2548)', async ({ browser, request }) => {
  const email = uniqueEmail('sso-race').toLowerCase();
  const { org, slug } = await seedSsoOrg('sso-rc');
  // Separate browser contexts, so each redemption carries its own CSRF cookie
  // and its own session jar — several tabs, or a leaked URL raced against its
  // owner. What this proves is the outcome: one grant, one session, however
  // many redemptions arrive together. It cannot reliably force the old
  // check-then-write interleaving over HTTP (the window is a few milliseconds,
  // and a local run passed against the unfixed provider), so the conditional
  // spend itself is pinned where it can be forced: scripts/test/grant-spend.test.mjs.
  const RACERS = 8;
  const contexts = await Promise.all(Array.from({ length: RACERS }, () => browser.newContext()));
  try {
    const SAMLResponse = await mintAssertion(request, {
      samlRequest: await captureAuthnRequest(request, slug),
      mode: 'ok',
      email,
      name: 'Sso Race',
    });
    const acs = await request.post(`/api/auth/sso/${slug}/acs`, { form: { SAMLResponse }, maxRedirects: 0 });
    expect(acs.status()).toBe(303);
    const grant = new URL(acs.headers()['location']).searchParams.get('token')!;

    const csrf = await Promise.all(
      contexts.map(async (ctx) => ((await (await ctx.request.get('/api/auth/csrf')).json()) as { csrfToken: string }).csrfToken),
    );
    await Promise.all(
      contexts.map((ctx, i) =>
        ctx.request.post('/api/auth/callback/sso', { form: { csrfToken: csrf[i], grant, json: 'true' }, maxRedirects: 0 }),
      ),
    );
    const sessions = await Promise.all(contexts.map((ctx) => sessionEmail(ctx.request)));
    expect(sessions.filter((e) => e === email), `sessions: ${JSON.stringify(sessions)}`).toHaveLength(1);

    const user = await prisma.user.findFirst({ where: { email } });
    const grants = await prisma.ssoLoginGrant.findMany({ where: { userId: user!.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0].used).toBe(true);
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await dropSsoOrg(org.id, [email]);
  }
});

// --- OIDC -------------------------------------------------------------------

const OIDC_IMPLEMENTED = SSO_IMPLEMENTED_PROVIDERS.includes('oidc');

test('OIDC: a tenant configured for OIDC is inert and falls back to password login', async ({ request }) => {
  // Shipped behaviour today (#1537): OIDC is refused at the write boundary, and
  // a row written before that shipped must not produce a broken redirect.
  test.skip(OIDC_IMPLEMENTED, 'OIDC has shipped — this test describes the pre-#1929 behaviour');

  expect(
    validateSsoConfig({
      ssoEnabled: true,
      ssoProvider: 'oidc',
      ssoIssuer: idp.oidcIssuer,
      ssoEntryPoint: 'https://idp.example.com/authorize',
      ssoCertificate: null,
    })
  ).toBe(SSO_OIDC_UNSUPPORTED);

  const { org, slug } = await seedSsoOrg('sso-oidc-inert', { provider: 'oidc', certificate: null });
  try {
    const res = await request.get(`/api/auth/sso/${slug}/login`, { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()['location']).toContain('error=sso_unavailable');
  } finally {
    await dropSsoOrg(org.id, []);
  }
});

test('OIDC: the stub IdP serves discovery, JWKS, a code and a verifiable ID token', async ({ request }) => {
  // The app cannot complete an OIDC login yet (#1929), so this exercises the
  // harness rather than the product. It is not busywork: it keeps the OIDC half
  // of the stub from rotting between now and the day #1929 lands, and it pins
  // down what "wrong aud" / "wrong nonce" will mean when the app checks them.
  const discovery = await (await request.get(idp.oidcDiscoveryUrl)).json();
  expect(discovery.issuer).toBe(idp.oidcIssuer);
  expect(discovery.id_token_signing_alg_values_supported).toContain('RS256');

  const jwks = await (await request.get(discovery.jwks_uri)).json();
  const publicKey = crypto.createPublicKey({ key: jwks.keys[0] as crypto.JsonWebKey, format: 'jwk' });

  const nonce = crypto.randomBytes(8).toString('hex');
  const state = crypto.randomBytes(8).toString('hex');
  const redirectUri = 'http://localhost:3000/api/auth/sso/stub/callback';
  const authorize = await request.get(discovery.authorization_endpoint, {
    params: {
      client_id: 'e2e-oidc-client',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      email: 'oidc.stub@e2e.local',
    },
    maxRedirects: 0,
  });
  expect(authorize.status()).toBe(302);
  const back = new URL(authorize.headers()['location']);
  expect(back.origin + back.pathname).toBe(redirectUri);
  expect(back.searchParams.get('state')).toBe(state);
  const code = back.searchParams.get('code')!;
  expect(code).toBeTruthy();

  const token = await (
    await request.post(discovery.token_endpoint, {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: 'e2e-oidc-client',
        redirect_uri: redirectUri,
      },
    })
  ).json();
  expect(token.token_type).toBe('Bearer');

  const [header, payload, signature] = (token.id_token as string).split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  expect(
    crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')),
    'the ID token must verify against the advertised JWKS'
  ).toBe(true);
  expect(claims.iss).toBe(idp.oidcIssuer);
  expect(claims.aud).toBe('e2e-oidc-client');
  expect(claims.nonce).toBe(nonce);
  expect(claims.email).toBe('oidc.stub@e2e.local');
  expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // Authorization codes are single use, as at a real provider.
  const replay = await request.post(discovery.token_endpoint, {
    form: { grant_type: 'authorization_code', code, client_id: 'e2e-oidc-client' },
  });
  expect(replay.status()).toBe(400);
  expect((await replay.json()).error).toBe('invalid_grant');
});

test('OIDC: the round trip signs a user into the right tenant', async ({ page }) => {
  test.skip(
    !OIDC_IMPLEMENTED,
    'OIDC login is not implemented yet (#1929). The stub already serves discovery, JWKS, ' +
      'authorize and token, so this un-skips itself the moment "oidc" joins ' +
      'SSO_IMPLEMENTED_PROVIDERS — and the wrong-aud / wrong-nonce / expired / wrong-key ' +
      'variants of e2e/support/idp-mock.mjs are waiting for their negative cases.'
  );

  const { org, slug } = await seedSsoOrg('sso-oidc-rt', { provider: 'oidc', certificate: null });
  try {
    await page.goto('/auth/sso');
    await page.getByTestId('sso-slug-input').fill(slug);
    await page.getByTestId('sso-continue').click();

    // Deliberately protocol-agnostic about the identity: the app decides how it
    // builds the authorization URL, so the stub may not receive the `email`
    // query the entry point carries and will fall back to its default subject.
    await expect.poll(() => sessionEmail(page.request), { timeout: 30_000 }).not.toBeNull();
    const email = (await sessionEmail(page.request))!;
    // The address is the stub IdP's default subject, so it is NOT unique to this
    // run — and since #2590 the same address may sit in several organizations.
    // Ask for the account IN the tenant that ran the round trip.
    const user = await prisma.user.findFirst({ where: { email, orgId: org.id }, select: { id: true } });
    expect(user, 'the round trip should have signed the asserted identity into this tenant').not.toBeNull();
  } finally {
    await dropSsoOrg(org.id, []);
  }
});
