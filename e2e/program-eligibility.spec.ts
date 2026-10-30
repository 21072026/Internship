import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

/**
 * Programme eligibility (#1945), end to end. Every refusal is proved by calling
 * the API directly — a hidden button is not a control. The precedence table
 * itself is unit-tested in scripts/test/eligibility.test.mjs; this pins the
 * enforcement points that share it: POST /api/mentorship, the public apply
 * form, SSO JIT provisioning, and the invitation exemption.
 */

const PASSWORD = 'Eligible123!';
const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrg(prefix: string, extra: Record<string, unknown> = {}) {
  const slug = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  return prisma.organization.create({ data: { name: `Elig ${slug}`, slug, plan: 'ENTERPRISE', ...extra } });
}

async function adminContext(orgId: string, email: string) {
  await seedUser(email, PASSWORD, 'ADMIN', 'Elig Admin', orgId);
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const signIn = await signInViaApi(ctx, email, PASSWORD);
  expect(signIn.ok, `admin sign-in failed: ${signIn.error}`).toBe(true);
  return ctx;
}

async function cleanup(orgId: string, emails: string[]) {
  const users = await prisma.user.findMany({ where: { orgId }, select: { id: true, email: true } });
  const ids = users.map((u) => u.id);
  await prisma.ssoLoginGrant.deleteMany({ where: { userId: { in: ids } } });
  await prisma.mentorshipRequest.deleteMany({ where: { menteeId: { in: ids } } });
  await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ menteeId: { in: ids } }, { mentorId: { in: ids } }] } });
  for (const email of new Set([...emails, ...users.map((u) => u.email)])) await cleanupByEmail(email);
  await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
}

test('eligibility: RULES admits only an ALLOW match, DENY beats ALLOW, and POST /api/mentorship answers 403 naming the rule', { tag: '@smoke' }, async () => {
  const org = await seedOrg('elig-rel');
  const adminEmail = uniqueEmail('elig-admin').toLowerCase();
  const mentorEmail = uniqueEmail('elig-mentor').toLowerCase();
  const engBerlin = uniqueEmail('elig-eng-berlin').toLowerCase();
  const engKoln = uniqueEmail('elig-eng-koln').toLowerCase();
  const sales = uniqueEmail('elig-sales').toLowerCase();
  const admin = await adminContext(org.id, adminEmail);
  try {
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Elig Mentor', org.id);
    const mk = async (email: string, department: string, city: string) => {
      const u = await seedUser(email, PASSWORD, 'MENTEE', email.split('@')[0], org.id);
      return prisma.user.update({ where: { id: u.id }, data: { department, city } });
    };
    const a = await mk(engBerlin, 'Engineering', 'Berlin');
    const b = await mk(engKoln, 'Engineering', 'Köln');
    const c = await mk(sales, 'Sales', 'Köln');

    // OPEN is the default: nothing changes for an existing tenant.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).eligibilityMode).toBe('OPEN');

    // --- the write boundary --------------------------------------------------
    const allow = await admin.post('/api/admin/eligibility', { data: { effect: 'ALLOW', attribute: 'department', operator: 'IN', value: ['engineering'], priority: 0 } });
    expect(allow.status()).toBe(201);
    const deny = await admin.post('/api/admin/eligibility', { data: { effect: 'DENY', attribute: 'city', operator: 'EQUALS', value: 'Berlin', priority: 0 } });
    expect(deny.status()).toBe(201);
    const denyId = (await deny.json()).rule.id as string;
    const refused = await admin.post('/api/admin/eligibility', { data: { effect: 'ALLOW', attribute: 'role', operator: 'EQUALS', value: 'ADMIN' } });
    expect((await refused.json()).code).toBe('invalid_attribute');

    // --- the dry run, before the mode is switched ---------------------------
    const listed = await (await admin.get('/api/admin/eligibility')).json();
    const draft = listed.rules.map((r: Record<string, unknown>) => ({ effect: r.effect, attribute: r.attribute, operator: r.operator, value: r.value, priority: r.priority }));
    const preview = await (await admin.post('/api/admin/eligibility/preview', { data: { mode: 'RULES', rules: draft } })).json();
    expect(preview).toEqual({ total: 3, admitted: 1 }); // only engineering-in-Köln
    // Still OPEN, so the dry run changed nothing: anyone can be assigned.
    expect((await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: c.id } })).status()).toBe(201);
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: c.id } });

    expect((await admin.patch('/api/admin/eligibility', { data: { mode: 'RULES' } })).status()).toBe(200);

    // DENY beats ALLOW at equal priority — and the 403 names the rule.
    const deniedRes = await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: a.id } });
    expect(deniedRes.status()).toBe(403);
    expect(await deniedRes.json()).toMatchObject({ code: 'not_eligible', reason: 'denied', ruleId: denyId });
    // No ALLOW match: ineligible by default.
    const noMatch = await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: c.id } });
    expect(noMatch.status()).toBe(403);
    expect(await noMatch.json()).toMatchObject({ code: 'not_eligible', reason: 'no_matching_rule' });
    // The ALLOW match is enrolled.
    expect((await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: b.id } })).status()).toBe(201);
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: { in: [a.id, c.id] } } })).toBe(0);

    // Matching never proposes the ineligible: mentor-suggest refuses too.
    expect((await admin.post('/api/admin/mentor-suggest', { data: { menteeId: a.id } })).status()).toBe(403);
  } finally {
    await admin.dispose();
    await cleanup(org.id, [adminEmail, mentorEmail, engBerlin, engKoln, sales]);
  }
});

test('eligibility: the public apply form refuses an ineligible applicant with 403 and files nothing; an invitation is never blocked', { tag: '@smoke' }, async ({ request }) => {
  const org = await seedOrg('elig-apply', { eligibilityMode: 'RULES' });
  const mentorEmail = uniqueEmail('elig-apply-mentor').toLowerCase();
  const outEmail = uniqueEmail('elig-apply-out').toLowerCase();
  const inEmail = uniqueEmail('elig-apply-in').toLowerCase();
  const invitedEmail = uniqueEmail('elig-invited').toLowerCase();
  try {
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Apply Mentor', org.id);
    await prisma.programEligibilityRule.create({ data: { orgId: org.id, effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin', 'Istanbul'] } });

    const out = await request.post('/api/apply', {
      headers: freshIp('elig apply out'),
      data: { mentorId: mentor.id, fullName: 'Out Side', email: outEmail, city: 'Paris' },
    });
    expect(out.status()).toBe(403);
    const body = await out.json();
    expect(body.code).toBe('not_eligible');
    expect(JSON.stringify(body), 'the applicant is not told which rule').not.toContain('ruleId');
    expect(await prisma.user.count({ where: { email: outEmail } })).toBe(0);

    const ok = await request.post('/api/apply', {
      headers: freshIp('elig apply in'),
      data: { mentorId: mentor.id, fullName: 'In Side', email: inEmail, city: 'istanbul' },
    });
    expect(ok.ok(), await ok.text()).toBe(true);

    // The invitation IS the exception: an invited registration whose profile
    // no rule admits still registers, active.
    const invite = await prisma.invitationToken.create({
      data: { token: `elig-${crypto.randomBytes(12).toString('hex')}`, email: invitedEmail, role: 'MENTEE', expiresAt: new Date(Date.now() + 86_400_000), orgId: org.id },
    });
    const reg = await request.post('/api/register', {
      headers: freshIp('elig invited register'),
      data: { token: invite.token, email: invitedEmail, password: PASSWORD, fullName: 'Invited Outsider' },
    });
    expect(reg.status()).toBe(201);
    const invited = await prisma.user.findFirstOrThrow({ where: { email: invitedEmail, orgId: org.id } });
    expect(invited.pendingApproval).toBe(false);
  } finally {
    await cleanup(org.id, [mentorEmail, outEmail, inEmail, invitedEmail]);
  }
});

test('eligibility: an SSO user no rule admits is provisioned inactive for approval — the login does not fail with a 500', { tag: '@smoke' }, async ({ request }) => {
  test.skip(!!process.env.BASE_URL, 'the stub IdP only runs under the local webServer');
  const idp = await (await fetch(`${MOCK}/__state`)).json();
  const org = await seedOrg('elig-sso', {
    eligibilityMode: 'RULES',
    ssoEnabled: true,
    ssoProvider: 'saml',
    ssoIssuer: idp.samlIssuer,
    ssoEntryPoint: idp.samlSsoUrl,
    ssoCertificate: idp.samlCertificate,
  });
  const heldEmail = uniqueEmail('elig-sso-held').toLowerCase();
  const inEmail = uniqueEmail('elig-sso-in').toLowerCase();
  try {
    // The directory sync (#1943) writes the department the rule reads.
    await prisma.ssoAttributeMapping.create({ data: { orgId: org.id, claim: 'department', target: 'department' } });
    await prisma.programEligibilityRule.create({ data: { orgId: org.id, effect: 'ALLOW', attribute: 'department', operator: 'EQUALS', value: 'Engineering' } });

    const signIn = async (email: string, department: string) => {
      const login = await request.get(`/api/auth/sso/${org.slug}/login`, { maxRedirects: 0 });
      const samlRequest = new URL(login.headers()['location']).searchParams.get('SAMLRequest');
      const minted = await request.post(`${MOCK}/saml/mint`, { data: { samlRequest, email, name: 'Elig Sso', attributes: { department } } });
      const { SAMLResponse } = await minted.json();
      return request.post(`/api/auth/sso/${org.slug}/acs`, { form: { SAMLResponse }, maxRedirects: 0 });
    };

    const held = await signIn(heldEmail, 'Sales');
    expect(held.status()).toBe(303);
    expect(held.headers()['location']).toContain('/auth/signin?error=sso_pending_approval');
    const heldUser = await prisma.user.findFirstOrThrow({ where: { email: heldEmail, orgId: org.id } });
    expect(heldUser.isActive).toBe(false);
    expect(heldUser.pendingApproval).toBe(true);
    expect(await prisma.ssoLoginGrant.count({ where: { userId: heldUser.id } })).toBe(0);
    const log = await prisma.activityLog.findFirst({ where: { action: 'eligibility.denied', targetId: heldUser.id } });
    expect(log?.level).toBe('WARNING');
    // Signing in again while waiting is the same answer, still no grant.
    expect((await signIn(heldEmail, 'Sales')).headers()['location']).toContain('sso_pending_approval');

    const admitted = await signIn(inEmail, 'Engineering');
    expect(admitted.headers()['location']).toContain('/auth/sso/complete?token=');
    const inUser = await prisma.user.findFirstOrThrow({ where: { email: inEmail, orgId: org.id } });
    expect(inUser.isActive).toBe(true);
  } finally {
    await cleanup(org.id, [heldEmail, inEmail]);
  }
});
