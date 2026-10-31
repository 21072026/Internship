import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// Employer self-signup (#1865, docs/company-verification.md): a company signs
// itself up, is PENDING and invisible to candidates, registers through the
// mailed link (never in the response), sees its onboarding card with the DNS
// fast path, cannot publish — and once an admin verifies it, its role is on
// the board.

const PW = 'CompanySignup123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
// A synthetic work domain: unique per run so the companies never collide.
const domain = `acme-${stamp}.example`;
const contactEmail = `hr@${domain}`;
const companyName = `Acme Signup ${stamp}`;
const emails = { admin: uniqueEmail('cs-admin'), mentee: uniqueEmail('cs-mentee') };

// The org an unmapped internship host's public form lands in (src/lib/defaultOrg.ts).
async function defaultOrgId(): Promise<string> {
  const org = await prisma.organization.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: 'Default Organization' }, select: { id: true } });
  return org.id;
}

test.describe.configure({ mode: 'serial' });

let orgId: string;

test.beforeAll(async () => {
  orgId = await defaultOrgId();
  const hash = await bcrypt.hash(PW, 10);
  await prisma.user.create({ data: { email: emails.admin, password: hash, role: 'ADMIN', orgId, fullName: 'CS Admin', skills: [] } });
  await prisma.user.create({ data: { email: emails.mentee, password: hash, role: 'MENTEE', orgId, fullName: 'CS Mentee', skills: [] } });
});

test.afterAll(async () => {
  const company = await prisma.company.findFirst({ where: { name: companyName }, select: { id: true } });
  const users = await prisma.user.findMany({ where: { email: { in: [...Object.values(emails), contactEmail] } }, select: { id: true } });
  await prisma.notification.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {});
  if (company) {
    await prisma.auditLog.deleteMany({ where: { targetId: company.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { targetId: company.id } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { companyId: company.id } }).catch(() => {});
  }
  await prisma.invitationToken.deleteMany({ where: { email: contactEmail } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: [...Object.values(emails), contactEmail] } } }).catch(() => {});
  if (company) await prisma.company.deleteMany({ where: { id: company.id } }).catch(() => {});
  await prisma.$disconnect();
});

const body = (extra: Record<string, unknown> = {}) => ({
  companyName,
  contactName: 'Ada Lovelace',
  email: contactEmail,
  industry: 'Robotics',
  consent: true,
  renderedAt: Date.now() - 10_000,
  ...extra,
});

test('sign-up → PENDING and invisible → registered → verified and visible', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  try {
    const freeMail = await anon.post('/api/public/signup/company', { headers: freshIp('company-signup free mail'), data: body({ email: `someone-${stamp}@gmail.com` }) });
    expect(freeMail.status()).toBe(400);
    expect((await freeMail.json()).code).toBe('free_mail_domain');

    const res = await anon.post('/api/public/signup/company', { headers: freshIp('company-signup'), data: body() });
    expect(res.status()).toBe(202);
    const text = await res.text();
    const company = await prisma.company.findFirstOrThrow({ where: { name: companyName } });
    expect(company).toMatchObject({ orgId, verificationStatus: 'PENDING', signupDomain: domain });
    const invitation = await prisma.invitationToken.findFirstOrThrow({ where: { email: contactEmail } });
    expect(invitation).toMatchObject({ role: 'COMPANY', companyId: company.id, invitedById: null });
    // The set-password link is mailed, never answered.
    expect(text).not.toContain(invitation.token);

    // The same address again answers the same, and creates nothing.
    const again = await anon.post('/api/public/signup/company', { headers: freshIp('company-signup again'), data: body() });
    expect(again.status()).toBe(202);
    expect(await prisma.company.count({ where: { name: companyName } })).toBe(1);

    // The admins were told.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: emails.admin } });
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'signup.companySelf' } })).toBe(1);

    // The employer registers through the link.
    const registered = await anon.post('/api/register', {
      headers: freshIp('company-signup register'),
      data: { token: invitation.token, email: contactEmail, password: PW, fullName: 'Ada Lovelace', consent: true },
    });
    expect(registered.status()).toBeLessThan(300);
    const user = await prisma.user.findFirstOrThrow({ where: { email: contactEmail, orgId } });
    expect(user).toMatchObject({ role: 'COMPANY', companyId: company.id });

    // Its own onboarding: pending, with the DNS record that would verify it.
    const companyCtx = await playwright.request.newContext({ baseURL });
    try {
      expect((await signInViaApi(companyCtx, contactEmail, PW)).ok).toBe(true);
      const onboarding = await (await companyCtx.get('/api/company/onboarding')).json();
      expect(onboarding.verificationStatus).toBe('PENDING');
      expect(onboarding.domainProofRecord).toMatch(/^interncrm-verification=[0-9a-f]{32}$/);
      expect(onboarding.checklist).toMatchObject({ verified: false, requisition: false });

      // A draft is fine, publishing is not.
      const draft = await companyCtx.post('/api/requisitions', { data: { title: `Signup role ${stamp}`, status: 'DRAFT', openings: 1, filled: 0, requiredSkills: [] } });
      expect(draft.status()).toBe(201);
      const reqId = (await draft.json()).requisition.id as string;
      const publish = await companyCtx.patch(`/api/requisitions/${reqId}`, { data: { status: 'OPEN' } });
      expect(publish.status()).toBe(403);
      expect((await publish.json()).code).toBe('company_not_verified');
      // The domain check finds no record on a synthetic domain, and changes nothing.
      const proof = await companyCtx.post('/api/company/onboarding/domain-proof');
      expect((await proof.json()).code).toBe('record_not_found');

      // An admin verifies it; now it may publish, and the mentee sees the role.
      const adminCtx = await playwright.request.newContext({ baseURL });
      try {
        expect((await signInViaApi(adminCtx, emails.admin, PW)).ok).toBe(true);
        expect((await adminCtx.post(`/api/admin/companies/${company.id}/verification`, { data: { action: 'approve' } })).status()).toBe(200);
      } finally {
        await adminCtx.dispose();
      }
      expect((await companyCtx.patch(`/api/requisitions/${reqId}`, { data: { status: 'OPEN' } })).status()).toBe(200);
      const after = await (await companyCtx.get('/api/company/onboarding')).json();
      expect(after).toMatchObject({ verificationStatus: 'VERIFIED', domainProofRecord: null });

      const menteeCtx = await playwright.request.newContext({ baseURL });
      try {
        expect((await signInViaApi(menteeCtx, emails.mentee, PW)).ok).toBe(true);
        const board = await (await menteeCtx.get(`/api/portal/requisitions?q=${encodeURIComponent(`Signup role ${stamp}`)}`)).json();
        expect(board.jobs.map((j: { id: string }) => j.id)).toEqual([reqId]);
      } finally {
        await menteeCtx.dispose();
      }
    } finally {
      await companyCtx.dispose();
    }
  } finally {
    await anon.dispose();
  }
});

test('the public page renders the form and the for-companies page links to it', async ({ page }) => {
  await page.goto('/for-companies');
  await expect(page.getByTestId('for-companies-signup-link')).toBeVisible();
  await page.goto('/for-companies/signup');
  await expect(page.getByTestId('company-signup-form')).toBeVisible();
});
