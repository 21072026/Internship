import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi, asHost, MARKETING_HOST } from './helpers/auth';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

/**
 * IdP role mapping (#1940), end to end against the stub IdP.
 *
 * docs/sso-saml.md promised "a default least-privilege MENTEE, or an IdP-mapped
 * role"; only the first half existed. This drives the real chain — the tenant
 * admin writes a mapping through the API, the stub IdP signs an assertion with
 * a multi-valued `groups` attribute, the ACS verifies it, and the provisioned
 * user carries the mapped role. The pure rule (priority, tie → less privilege,
 * ADMIN ignored) is unit-tested in scripts/test/sso-role-mapping.test.mjs.
 *
 * The second test is the vertical gate (#2839): a MARKETING tenant is offered,
 * and may write, only the roles its product has — never SOURCE — and a row that
 * holds such a role anyway is ignored by the ACS.
 */

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const PASSWORD = 'RoleMap123!';

let idp: { samlIssuer: string; samlSsoUrl: string; samlCertificate: string };

test.beforeEach(() => {
  test.skip(!!process.env.BASE_URL, 'the stub IdP only runs under the local webServer');
});

test.beforeAll(async () => {
  if (process.env.BASE_URL) return;
  idp = await (await fetch(`${MOCK}/__state`)).json();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrg(prefix: string, sso: boolean, vertical: 'INTERNSHIP' | 'MARKETING' = 'INTERNSHIP') {
  const slug = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  return prisma.organization.create({
    data: {
      name: `SSO ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      vertical,
      ...(sso
        ? {
            ssoEnabled: true,
            ssoProvider: 'saml',
            ssoIssuer: idp.samlIssuer,
            ssoEntryPoint: idp.samlSsoUrl,
            ssoCertificate: idp.samlCertificate,
          }
        : {}),
    },
  });
}

/** `host` — a MARKETING org's admin signs in, and stays, on the marketing host (#2590). */
async function adminContext(orgId: string, email: string, host?: string) {
  await seedUser(email, PASSWORD, 'ADMIN', 'Role Map Admin', orgId);
  const ctx = await playwrightRequest.newContext({
    baseURL: test.info().project.use.baseURL,
    ...(host ? { extraHTTPHeaders: asHost(host) } : {}),
  });
  const signIn = await signInViaApi(ctx, email, PASSWORD);
  expect(signIn.ok, `admin sign-in failed: ${signIn.error}`).toBe(true);
  return ctx;
}

/** One SP-initiated round trip, browserless: login route → stub mint → ACS. */
async function ssoSignIn(
  request: APIRequestContext,
  slug: string,
  email: string,
  groups: string[],
  headers: Record<string, string> = {},
) {
  const login = await request.get(`/api/auth/sso/${slug}/login`, { headers, maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  const samlRequest = new URL(login.headers()['location']).searchParams.get('SAMLRequest');
  expect(samlRequest).toBeTruthy();
  const minted = await request.post(`${MOCK}/saml/mint`, {
    data: { samlRequest, email, name: 'Role Mapped', groups },
  });
  expect(minted.ok()).toBeTruthy();
  const { SAMLResponse } = await minted.json();
  const acs = await request.post(`/api/auth/sso/${slug}/acs`, { headers, form: { SAMLResponse }, maxRedirects: 0 });
  expect(acs.status()).toBe(303);
  expect(acs.headers()['location']).toContain('/auth/sso/complete?token=');
}

test('SSO role mapping: a mapped group provisions its role, no match stays MENTEE, re-sync is opt-in and audited', async ({
  request,
}) => {
  const org = await seedOrg('sso-roles', true);
  const other = await seedOrg('sso-roles-foreign', false);
  const adminEmail = uniqueEmail('sso-roles-admin').toLowerCase();
  const foreignEmail = uniqueEmail('sso-roles-foreign').toLowerCase();
  const mentorEmail = uniqueEmail('sso-roles-mentor').toLowerCase();
  const plainEmail = uniqueEmail('sso-roles-plain').toLowerCase();
  const admin = await adminContext(org.id, adminEmail);
  const foreign = await adminContext(other.id, foreignEmail);
  const api = `/api/admin/organizations/${org.id}/sso-role-mappings`;
  try {
    // --- the write boundary ---------------------------------------------
    const created = await admin.post(api, { data: { claim: 'groups', matchValue: 'CRM-Mentors', role: 'MENTOR' } });
    expect(created.status()).toBe(201);

    const asAdmin = await admin.post(api, { data: { claim: 'groups', matchValue: 'crm-admins', role: 'ADMIN' } });
    expect(asAdmin.status()).toBe(400);
    expect((await asAdmin.json()).code).toBe('admin_mapping_unavailable');

    const dup = await admin.post(api, { data: { claim: 'groups', matchValue: 'CRM-Mentors', role: 'COMPANY' } });
    expect(dup.status()).toBe(409);

    // Another tenant's admin can neither read nor write this org's mappings.
    expect((await foreign.get(api)).status()).toBe(403);
    expect((await foreign.post(api, { data: { claim: 'groups', matchValue: 'x', role: 'MENTOR' } })).status()).toBe(403);

    const listed = await (await admin.get(api)).json();
    expect(listed.syncRole).toBe(false);
    expect(listed.roles).not.toContain('ADMIN');
    expect(listed.mappings).toHaveLength(1);

    // --- provisioning -----------------------------------------------------
    // Values compare case-insensitively: the IdP sends "crm-mentors".
    await ssoSignIn(request, org.slug, mentorEmail, ['staff', 'crm-mentors']);
    const mentor = await prisma.user.findFirst({ where: { email: mentorEmail, orgId: org.id } });
    expect(mentor?.role).toBe('MENTOR');

    await ssoSignIn(request, org.slug, plainEmail, ['staff']);
    const plain = await prisma.user.findFirst({ where: { email: plainEmail, orgId: org.id } });
    expect(plain?.role, 'no matching mapping is least privilege').toBe('MENTEE');

    // --- re-evaluation on a returning sign-in ------------------------------
    // Sync off (the default): the IdP now says "mentors", the account stays MENTEE.
    await ssoSignIn(request, org.slug, plainEmail, ['crm-mentors']);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: plain!.id } })).role).toBe('MENTEE');

    const toggled = await admin.patch(api, { data: { syncRole: true } });
    expect(toggled.status()).toBe(200);

    await ssoSignIn(request, org.slug, plainEmail, ['crm-mentors']);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: plain!.id } })).role).toBe('MENTOR');
    const audit = await prisma.activityLog.findFirst({
      where: { action: 'sso.role_synced', targetId: plain!.id },
    });
    expect(audit?.level).toBe('WARNING');
    expect(audit?.detail).toContain('MENTEE -> MENTOR');

    // No match on a synced sign-in is not a demotion signal: resolveRole says
    // null, and null never rewrites an existing role.
    await ssoSignIn(request, org.slug, plainEmail, []);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: plain!.id } })).role).toBe('MENTOR');

    // --- delete, scoped ----------------------------------------------------
    const id = listed.mappings[0].id as string;
    expect((await foreign.delete(`/api/admin/organizations/${other.id}/sso-role-mappings?mappingId=${id}`)).status()).toBe(404);
    expect((await admin.delete(`${api}?mappingId=${id}`)).status()).toBe(200);
    expect(await prisma.ssoClaimMapping.count({ where: { orgId: org.id } })).toBe(0);
  } finally {
    await admin.dispose();
    await foreign.dispose();
    const users = await prisma.user.findMany({ where: { orgId: { in: [org.id, other.id] } }, select: { id: true, email: true } });
    await prisma.ssoLoginGrant.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    for (const email of new Set([adminEmail, foreignEmail, mentorEmail, plainEmail, ...users.map((u) => u.email)])) {
      await cleanupByEmail(email);
    }
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } }).catch(() => {});
  }
});

test('SSO role mapping: a MARKETING tenant is offered only its product\'s roles — never SOURCE — and a stray SOURCE row grants nothing (#2839)', async ({
  request,
}) => {
  const org = await seedOrg('sso-roles-mkt', true, 'MARKETING');
  const adminEmail = uniqueEmail('sso-roles-mkt-admin').toLowerCase();
  const partnerEmail = uniqueEmail('sso-roles-mkt-partner').toLowerCase();
  const admin = await adminContext(org.id, adminEmail, MARKETING_HOST);
  const api = `/api/admin/organizations/${org.id}/sso-role-mappings`;
  const onMarketing = asHost(MARKETING_HOST);
  try {
    // GET lists back exactly what POST accepts: MARKETING has no `sourcing`.
    const listed = await (await admin.get(api)).json();
    expect(listed.roles).toEqual(['MENTEE', 'COMPANY', 'MENTOR']);

    const asSource = await admin.post(api, { data: { claim: 'groups', matchValue: 'partners', role: 'SOURCE' } });
    expect(asSource.status()).toBe(400);
    expect((await asSource.json()).code).toBe('role_not_in_vertical');

    const asRep = await admin.post(api, { data: { claim: 'groups', matchValue: 'reps', role: 'MENTOR' } });
    expect(asRep.status(), 'a rep (MENTOR) is this product\'s role').toBe(201);

    // A row holding the role anyway — written before the gate, or by hand — is
    // ignored by the ACS the way an ADMIN row is, even at the highest priority.
    await prisma.ssoClaimMapping.create({
      data: { orgId: org.id, claim: 'groups', matchValue: 'partners', role: 'SOURCE', priority: 100 },
    });
    await ssoSignIn(request, org.slug, partnerEmail, ['partners'], onMarketing);
    const partner = await prisma.user.findFirst({ where: { email: partnerEmail, orgId: org.id } });
    expect(partner?.role, 'SOURCE is not a role this product has').toBe('MENTEE');
  } finally {
    await admin.dispose();
    const users = await prisma.user.findMany({ where: { orgId: org.id }, select: { id: true, email: true } });
    await prisma.ssoLoginGrant.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    for (const email of new Set([adminEmail, partnerEmail, ...users.map((u) => u.email)])) {
      await cleanupByEmail(email);
    }
    await prisma.ssoClaimMapping.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
