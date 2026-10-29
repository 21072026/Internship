import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, submitSignInForm } from './helpers/auth';

// #1398 — the candidate page's Hiring card and the read behind it:
// GET /api/candidates/[id]/hiring, scoped on the server per role. A PASS never
// reaches the candidate; a candidate the caller cannot see is a 404.

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'HiringPass123!';
const emails = {
  admin: uniqueEmail('ch-admin'), adminB: uniqueEmail('ch-admin-b'), mentor: uniqueEmail('ch-mentor'), otherMentor: uniqueEmail('ch-mentor-2'),
  company: uniqueEmail('ch-company'), otherCompany: uniqueEmail('ch-company-2'), mentee: uniqueEmail('ch-mentee'), quiet: uniqueEmail('ch-quiet'),
};
const ids: Record<string, string> = {};

async function login(page: Page, email: string) {
  await submitSignInForm(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

test.describe.serial('#1398 candidate hiring card', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    const orgA = await prisma.organization.create({ data: { name: `CH Org A ${stamp}`, slug: `ch-a-${stamp}` } });
    const orgB = await prisma.organization.create({ data: { name: `CH Org B ${stamp}`, slug: `ch-b-${stamp}` } });
    ids.orgA = orgA.id; ids.orgB = orgB.id;
    const acme = await prisma.company.create({ data: { name: `CH Acme ${stamp}`, orgId: orgA.id } });
    const globex = await prisma.company.create({ data: { name: `CH Globex ${stamp}`, orgId: orgA.id } });
    const user = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', orgId: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { email, password: hash, fullName: email.split('@')[0], role, orgId, skills: [], ...extra } });
    await user(emails.admin, 'ADMIN', orgA.id);
    await user(emails.adminB, 'ADMIN', orgB.id);
    const mentor = await user(emails.mentor, 'MENTOR', orgA.id);
    await user(emails.otherMentor, 'MENTOR', orgA.id);
    await user(emails.company, 'COMPANY', orgA.id, { companyId: acme.id });
    await user(emails.otherCompany, 'COMPANY', orgA.id, { companyId: globex.id });
    ids.mentee = (await user(emails.mentee, 'MENTEE', orgA.id)).id;
    ids.quiet = (await user(emails.quiet, 'MENTEE', orgA.id)).id;
    await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: mentor.id, menteeId: ids.mentee, companyId: acme.id, status: 'ACTIVE' } });

    const reqAcme = await prisma.requisition.create({ data: { orgId: orgA.id, companyId: acme.id, title: `CH Frontend ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [] } });
    const reqGlobex = await prisma.requisition.create({ data: { orgId: orgA.id, companyId: globex.id, title: `CH Data ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [] } });
    ids.reqAcme = reqAcme.id;
    const app = await prisma.application.create({
      data: { orgId: orgA.id, requisitionId: reqAcme.id, menteeId: ids.mentee, companyId: acme.id, stage: 'SHORTLISTED', status: 'ACTIVE', source: 'SHORTLIST', events: { create: { fromStage: null, toStage: 'SHORTLISTED' } } },
    });
    ids.app = app.id;
    ids.interestAcme = (await prisma.companyInterest.create({ data: { companyId: acme.id, menteeId: ids.mentee, requisitionId: reqAcme.id, status: 'SHORTLISTED', note: `acme note ${stamp}` } })).id;
    ids.interestGlobex = (await prisma.companyInterest.create({ data: { companyId: globex.id, menteeId: ids.mentee, requisitionId: reqGlobex.id, status: 'PASS', note: `globex note ${stamp}` } })).id;
    ids.ir = (await prisma.interviewRequest.create({
      data: { orgId: orgA.id, requisitionId: reqAcme.id, menteeId: ids.mentee, companyId: acme.id, status: 'PENDING', proposedSlots: ['2030-01-15T09:00:00.000Z'] },
    })).id;
  });

  test.afterAll(async () => {
    const orgs = [ids.orgA, ids.orgB].filter(Boolean);
    await prisma.interviewRequest.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.companyInterest.deleteMany({ where: { menteeId: { in: [ids.mentee, ids.quiet].filter(Boolean) } } }).catch(() => {});
    await prisma.application.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('each role reads only its own rows; the candidate and outsiders are refused', { tag: '@smoke' }, async ({ page }) => {
    const url = () => `/api/candidates/${ids.mentee}/hiring`;

    await login(page, emails.admin);
    const admin = await (await page.request.get(url())).json();
    expect(admin.applications.map((a: { id: string }) => a.id)).toEqual([ids.app]);
    expect(admin.interests.map((i: { id: string }) => i.id).sort()).toEqual([ids.interestAcme, ids.interestGlobex].sort());
    expect(admin.interests.find((i: { id: string }) => i.id === ids.interestGlobex)).toMatchObject({ status: 'PASS', note: `globex note ${stamp}` });
    expect(admin.interviewRequests.map((r: { id: string }) => r.id)).toEqual([ids.ir]);

    await login(page, emails.company);
    const company = await (await page.request.get(url())).json();
    // Only Acme's rows; Globex's PASS is not Acme's business.
    expect(company.interests.map((i: { id: string }) => i.id)).toEqual([ids.interestAcme]);
    expect(company.applications).toHaveLength(1);
    expect(company.interviewRequests).toHaveLength(1);

    await login(page, emails.mentor);
    const mentor = await (await page.request.get(url())).json();
    expect(mentor.interests).toHaveLength(2);
    // A company's private note does not go to the mentor.
    expect(mentor.interests.every((i: Record<string, unknown>) => !('note' in i))).toBe(true);

    // The candidate never reads this view — a PASS is never relayed to them.
    await login(page, emails.mentee);
    expect((await page.request.get(url())).status()).toBe(403);
    // Not your mentee / no row of yours / another org: 404, never an empty 200.
    await login(page, emails.otherMentor);
    expect((await page.request.get(url())).status()).toBe(404);
    await login(page, emails.otherCompany);
    expect((await page.request.get(`/api/candidates/${ids.quiet}/hiring`)).status()).toBe(404);
    await login(page, emails.adminB);
    expect((await page.request.get(url())).status()).toBe(404);
  });

  test('the candidate page shows the Hiring card, and an empty state that is not the loading state', async ({ page }) => {
    await login(page, emails.admin);
    await gotoSettled(page, `/admin/candidates/${ids.mentee}`);
    const card = page.getByTestId('candidate-hiring');
    await expect(card.getByTestId(`candidate-hiring-application-${ids.app}`)).toContainText(`CH Frontend ${stamp}`, { timeout: 60_000 });
    await expect(card.getByTestId(`candidate-hiring-interest-${ids.interestGlobex}`)).toContainText(`CH Globex ${stamp}`);
    await expect(card.getByTestId(`candidate-hiring-interview-${ids.ir}`)).toBeVisible();
    await expect(card.getByRole('link', { name: `CH Frontend ${stamp}` }).first()).toHaveAttribute('href', `/admin/requisitions/${ids.reqAcme}`);

    await gotoSettled(page, `/admin/candidates/${ids.quiet}`);
    await expect(page.getByTestId('candidate-hiring-empty')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('candidate-hiring-loading')).toHaveCount(0);
  });
});
