import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Introductions from the talent pool (#1394, docs/candidate-outreach.md).
 *
 * A company asks to be introduced to a candidate it found in the talent pool —
 * no shortlist needed, but the candidate must be in the pool THIS company may
 * search (public profile, active TALENT_POOL_VISIBILITY consent, same org).
 * The first test is the privacy boundary (@smoke): no response the company
 * reads before an approval carries a contact detail, and a person outside the
 * pool answers 404. The second walks request → admin approval for a candidate
 * with no mentor, and the audit trail.
 */

const PW = 'TalentIntro123!';

// Every key a company may ever read about a pool candidate or its own request.
const POOL_KEYS = ['avatarUrl', 'city', 'department', 'fullName', 'graduationYear', 'id', 'skills', 'targetPosition', 'university'];
const REQUEST_KEYS = ['createdAt', 'decidedAt', 'id', 'menteeId', 'menteeName', 'source', 'status'];
const CONTACT_KEYS = ['email', 'phone', 'address', 'linkedinUrl', 'birthDate', 'lastName', 'password'];

function assertNoContact(value: unknown, where: string) {
  const text = JSON.stringify(value);
  for (const key of CONTACT_KEYS) expect(text, `${where} carries "${key}"`).not.toContain(`"${key}"`);
}

test.describe('talent-pool introductions', () => {
  const stamp = `${Date.now()}`;
  const emails = {
    company: uniqueEmail('tpi-company'),
    admin: uniqueEmail('tpi-admin'),
    pool: uniqueEmail('tpi-pool'),
    quiet: uniqueEmail('tpi-quiet'),
    foreign: uniqueEmail('tpi-foreign'),
  };
  let orgId = '';
  let otherOrgId = '';
  let companyId = '';
  let pool = { id: '' };
  let quiet = { id: '' };
  let foreign = { id: '' };

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `TPI Org ${stamp}`, slug: `tpi-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `TPI Other ${stamp}`, slug: `tpi-o-${stamp}` } })).id;
    companyId = (await prisma.company.create({ data: { name: `Acme Talent ${stamp}`, orgId } })).id;
    await prisma.companyEntitlement.create({ data: { companyId, feature: 'TALENT_POOL_SEARCH' } });
    await prisma.user.create({
      data: { email: emails.company, password: await bcrypt.hash(PW, 10), role: 'COMPANY', fullName: 'Acme Talent Lead', companyId, orgId, skills: [] },
    });
    await seedUser(emails.admin, PW, 'ADMIN', `TPI Admin ${stamp}`, orgId);
    // In the pool (public, consented, no mentor); public without consent; in the
    // pool of ANOTHER org.
    const mk = async (email: string, name: string, org: string, consent: boolean) => {
      const u = await seedUser(email, PW, 'MENTEE', name, org);
      await prisma.user.update({ where: { id: u.id }, data: { publicProfile: true, university: 'Example Tech', phone: '+49 30 000000', city: 'Berlin', skills: ['Go'] } });
      if (consent) await prisma.userConsent.create({ data: { userId: u.id, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } });
      return u;
    };
    pool = await mk(emails.pool, `Pool Candidate ${stamp}`, orgId, true);
    quiet = await mk(emails.quiet, `Quiet Candidate ${stamp}`, orgId, false);
    foreign = await mk(emails.foreign, `Foreign Candidate ${stamp}`, otherOrgId, true);
  });

  test.afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId, action: { startsWith: 'OUTREACH_' } } });
    await prisma.candidateOutreach.deleteMany({ where: { orgId } });
    await prisma.notification.deleteMany({ where: { type: { startsWith: 'outreach.' }, user: { orgId } } });
    await prisma.companyEntitlement.deleteMany({ where: { companyId } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  async function companyPage(browser: import('@playwright/test').Browser): Promise<Page> {
    const page = await browser.newPage();
    await signInAndSettle(page, emails.company, PW, '/company');
    return page;
  }

  test('nothing a company reads before approval carries a contact detail; outside the pool is 404', { tag: '@smoke' }, async ({ browser }) => {
    test.setTimeout(120_000);
    const company = await companyPage(browser);
    try {
      const search = await company.request.get('/api/company/talent-pool');
      expect(search.ok()).toBeTruthy();
      const candidates = (await search.json()).candidates as Record<string, unknown>[];
      const mine = candidates.find((c) => c.id === pool.id);
      expect(mine, 'the pool candidate is listed').toBeTruthy();
      expect(candidates.map((c) => c.id)).not.toContain(quiet.id);
      expect(candidates.map((c) => c.id)).not.toContain(foreign.id);
      for (const c of candidates) expect(Object.keys(c).sort()).toEqual(POOL_KEYS);
      assertNoContact(candidates, 'the talent-pool search');

      // Outside the pool: no consent, or another org — answered like nobody.
      for (const id of [quiet.id, foreign.id, 'no-such-user']) {
        const res = await company.request.post('/api/company/outreach', { data: { menteeId: id, message: 'hello', via: 'TALENT_POOL' } });
        expect(res.status(), `request for ${id}`).toBe(404);
        assertNoContact(await res.json(), 'a refused request');
      }

      const created = await company.request.post('/api/company/outreach', { data: { menteeId: pool.id, message: `Hello from Acme ${stamp}`, via: 'TALENT_POOL' } });
      expect(created.status()).toBe(201);
      const body = await created.json();
      expect(Object.keys(body.request).sort()).toEqual(['id', 'status']);
      assertNoContact(body, 'the request answer');

      // A second request while one waits is refused.
      expect((await company.request.post('/api/company/outreach', { data: { menteeId: pool.id, message: 'again', via: 'TALENT_POOL' } })).status()).toBe(409);

      const list = (await (await company.request.get('/api/company/outreach')).json()).requests as Record<string, unknown>[];
      const row = list.find((r) => r.menteeId === pool.id)!;
      expect(Object.keys(row).sort()).toEqual(REQUEST_KEYS);
      expect(row).toMatchObject({ source: 'TALENT_POOL', status: 'PENDING', decidedAt: null });
      assertNoContact(list, 'the request list');

      // A withdrawn consent closes the door at once: the next request is a 404.
      await prisma.candidateOutreach.deleteMany({ where: { orgId, menteeId: pool.id } });
      await prisma.userConsent.update({ where: { userId_type: { userId: pool.id, type: 'TALENT_POOL_VISIBILITY' } }, data: { revokedAt: new Date() } });
      expect((await company.request.post('/api/company/outreach', { data: { menteeId: pool.id, message: 'still there?', via: 'TALENT_POOL' } })).status()).toBe(404);
      await prisma.userConsent.update({ where: { userId_type: { userId: pool.id, type: 'TALENT_POOL_VISIBILITY' } }, data: { revokedAt: null } });
    } finally {
      await company.close();
    }
  });

  test('a pool introduction for a candidate without a mentor is the admins’ to approve, and every step is audited', async ({ browser }) => {
    test.setTimeout(180_000);
    const company = await companyPage(browser);
    const admin = await browser.newPage();
    try {
      const created = await company.request.post('/api/company/outreach', { data: { menteeId: pool.id, message: `Hi ${stamp}`, via: 'TALENT_POOL' } });
      expect(created.status()).toBe(201);
      const { id } = (await created.json()).request as { id: string };
      const adminUser = await prisma.user.findFirstOrThrow({ where: { email: emails.admin, orgId }, select: { id: true } });
      expect(await prisma.notification.count({ where: { userId: adminUser.id, type: 'outreach.requested' } })).toBeGreaterThan(0);
      // The candidate is not told while it waits.
      expect(await prisma.notification.count({ where: { userId: pool.id, type: { startsWith: 'outreach.' } } })).toBe(0);

      await signInAndSettle(admin, emails.admin, PW, '/admin');
      const queue = (await (await admin.request.get('/api/company/outreach')).json()).requests as { id: string; source: string }[];
      expect(queue.find((r) => r.id === id)?.source).toBe('TALENT_POOL');
      const approved = await admin.request.patch(`/api/company/outreach/${id}`, { data: { action: 'approve' } });
      expect(approved.ok()).toBeTruthy();

      const actions = (await prisma.auditLog.findMany({ where: { orgId, targetId: id }, select: { action: true } })).map((a) => a.action).sort();
      expect(actions).toEqual(['OUTREACH_APPROVED', 'OUTREACH_REQUESTED']);
      const requested = await prisma.auditLog.findFirstOrThrow({ where: { orgId, targetId: id, action: 'OUTREACH_REQUESTED' }, select: { detail: true } });
      expect(requested.detail).toContain('source=TALENT_POOL');
      expect(requested.detail).not.toContain(`Hi ${stamp}`);

      // The company's view after approval: still the request, never a contact field.
      const list = (await (await company.request.get('/api/company/outreach')).json()).requests;
      assertNoContact(list, 'the request list after approval');
    } finally {
      await company.close();
      await admin.close();
    }
  });
});
