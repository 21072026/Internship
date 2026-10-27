import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';

// #1401 — the admin's requisition detail: who fits the role (the one match
// rule, consenting pool only) and an admin-managed shortlist that is the
// Application at SHORTLISTED, written through the stage writer.

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'MatchPass123!';
const emails = {
  admin: uniqueEmail('rm-admin'), observer: uniqueEmail('rm-observer'), adminB: uniqueEmail('rm-admin-b'),
  company: uniqueEmail('rm-company'), mentor: uniqueEmail('rm-mentor'),
  fit: uniqueEmail('rm-fit'), partial: uniqueEmail('rm-partial'), noConsent: uniqueEmail('rm-noconsent'), foreign: uniqueEmail('rm-foreign'),
};
const ids: Record<string, string> = {};

async function login(page: Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

test.describe.serial('#1401 requisition matches + admin shortlist', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    const orgA = await prisma.organization.create({ data: { name: `RM Org A ${stamp}`, slug: `rm-a-${stamp}` } });
    const orgB = await prisma.organization.create({ data: { name: `RM Org B ${stamp}`, slug: `rm-b-${stamp}` } });
    ids.orgA = orgA.id; ids.orgB = orgB.id;
    const company = await prisma.company.create({ data: { name: `RM Acme ${stamp}`, orgId: orgA.id } });
    const companyB = await prisma.company.create({ data: { name: `RM Other ${stamp}`, orgId: orgB.id } });
    ids.company = company.id; ids.companyB = companyB.id;
    const user = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', orgId: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { email, password: hash, fullName: email.split('@')[0], role, orgId, skills: [], ...extra } });
    await user(emails.admin, 'ADMIN', orgA.id);
    await user(emails.observer, 'ADMIN', orgA.id, { adminLevel: 'OBSERVER' });
    await user(emails.adminB, 'ADMIN', orgB.id);
    await user(emails.company, 'COMPANY', orgA.id, { companyId: company.id });
    await user(emails.mentor, 'MENTOR', orgA.id);
    const pool = { publicProfile: true, targetPosition: 'Frontend Developer' };
    ids.fit = (await user(emails.fit, 'MENTEE', orgA.id, pool)).id;
    ids.partial = (await user(emails.partial, 'MENTEE', orgA.id, pool)).id;
    ids.noConsent = (await user(emails.noConsent, 'MENTEE', orgA.id, pool)).id;
    ids.foreign = (await user(emails.foreign, 'MENTEE', orgB.id, pool)).id;

    const skill = (orgId: string, key: string) => prisma.skill.create({ data: { orgId, key: `${key}-${stamp}`, labelEn: `${key} ${stamp}`.slice(0, 60), labelTr: key, labelDe: key } });
    const react = await skill(orgA.id, 'react'); const ts = await skill(orgA.id, 'typescript');
    const reactB = await skill(orgB.id, 'react'); const tsB = await skill(orgB.id, 'typescript');
    ids.reactLabel = react.labelEn;
    for (const [userId, skillIds] of [[ids.fit, [react.id, ts.id]], [ids.partial, [react.id]], [ids.noConsent, [react.id, ts.id]], [ids.foreign, [reactB.id, tsB.id]]] as const) {
      await prisma.userSkill.createMany({ data: skillIds.map((skillId) => ({ userId, skillId })) });
    }
    const consent = { type: 'TALENT_POOL_VISIBILITY' as const, grantedAt: new Date() };
    await prisma.userConsent.createMany({ data: [ids.fit, ids.partial, ids.foreign].map((userId) => ({ userId, ...consent })) });

    const req = await prisma.requisition.create({ data: { orgId: orgA.id, companyId: company.id, title: `Junior Frontend ${stamp}`, status: 'OPEN', openings: 2, requiredSkills: ['React', 'TypeScript'] } });
    await prisma.requisitionSkill.createMany({ data: [{ requisitionId: req.id, skillId: react.id }, { requisitionId: req.id, skillId: ts.id }] });
    ids.req = req.id;
    const reqB = await prisma.requisition.create({ data: { orgId: orgB.id, companyId: companyB.id, title: `Foreign ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [] } });
    ids.reqB = reqB.id;
  });

  test.afterAll(async () => {
    const orgs = [ids.orgA, ids.orgB].filter(Boolean);
    await prisma.application.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('matches: consenting pool of the org only, with the reason; other roles and orgs are refused', { tag: '@smoke' }, async ({ page }) => {
    await login(page, emails.admin);
    const res = await page.request.get(`/api/requisitions/${ids.req}/matches`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const matched = body.matches.map((m: { candidate: { id: string } }) => m.candidate.id);
    // One skill of two is not a match; no consent and another org are never listed.
    expect(matched).toEqual([ids.fit]);
    expect(body.matches[0].via).toBe('skills');
    expect(body.matches[0].direct).toContain(ids.reactLabel);
    expect(body.matches[0].application).toBeNull();
    // Another org's requisition is a 404, never a 403 that confirms the id.
    expect((await page.request.get(`/api/requisitions/${ids.reqB}/matches`)).status()).toBe(404);

    for (const email of [emails.company, emails.mentor]) {
      await page.context().clearCookies();
      await login(page, email);
      expect((await page.request.get(`/api/requisitions/${ids.req}/matches`)).status()).toBe(403);
      expect((await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.fit } })).status()).toBe(403);
    }
  });

  test('shortlist: an admin writes the Application at SHORTLISTED with its event; consent and tenancy are enforced', { tag: '@smoke' }, async ({ page }) => {
    await login(page, emails.observer);
    expect((await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.fit } })).status()).toBe(403);
    await page.context().clearCookies();

    await login(page, emails.admin);
    const added = await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.fit } });
    expect(added.status()).toBe(201);
    const app = await prisma.application.findUniqueOrThrow({
      where: { requisitionId_menteeId: { requisitionId: ids.req, menteeId: ids.fit } },
      include: { events: true },
    });
    expect(app).toMatchObject({ stage: 'SHORTLISTED', status: 'ACTIVE', source: 'ADMIN', companyId: ids.company });
    expect(app.events).toHaveLength(1);
    expect(app.events[0]).toMatchObject({ fromStage: null, toStage: 'SHORTLISTED' });
    expect(await prisma.activityLog.count({ where: { action: 'application.shortlist.add', targetId: app.id } })).toBe(1);

    // Again: nothing to do, no second event.
    const again = await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.fit } });
    expect(again.status()).toBe(200);
    expect((await again.json()).moved).toBe(false);
    expect(await prisma.applicationEvent.count({ where: { applicationId: app.id } })).toBe(1);

    const noConsent = await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.noConsent } });
    expect(noConsent.status()).toBe(409);
    expect((await noConsent.json()).code).toBe('no_consent');
    expect((await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.foreign } })).status()).toBe(404);
    expect((await page.request.post(`/api/requisitions/${ids.reqB}/shortlist`, { data: { menteeId: ids.fit } })).status()).toBe(404);

    // An earlier application is moved by the stage writer, not re-created.
    await prisma.userConsent.create({ data: { userId: ids.partial, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } }).catch(() => {});
    const applied = await prisma.application.create({
      data: { orgId: ids.orgA, requisitionId: ids.req, menteeId: ids.partial, companyId: ids.company, stage: 'APPLIED', status: 'ACTIVE', source: 'SELF', events: { create: { fromStage: null, toStage: 'APPLIED' } } },
    });
    const moved = await page.request.post(`/api/requisitions/${ids.req}/shortlist`, { data: { menteeId: ids.partial } });
    expect(moved.status()).toBe(200);
    expect(await moved.json()).toMatchObject({ applicationId: applied.id, moved: true, stage: 'SHORTLISTED' });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: applied.id } })).source).toBe('SELF');
    expect(await prisma.applicationEvent.count({ where: { applicationId: applied.id, fromStage: 'APPLIED', toStage: 'SHORTLISTED' } })).toBe(1);
  });

  test('the detail page lists applicants and matches, and removes from the shortlist with a reason', async ({ page }) => {
    await login(page, emails.admin);
    await gotoSettled(page, `/admin/requisitions/${ids.req}`);
    await expect(page.getByTestId('requisition-detail')).toBeVisible();
    await expect(page.getByTestId(`requisition-applicant-stage-${ids.fit}`)).toBeVisible();
    await expect(page.getByTestId(`requisition-match-${ids.fit}`)).toBeVisible();
    // Already shortlisted: no "add" button on the match.
    await expect(page.getByTestId(`requisition-shortlist-${ids.fit}`)).toHaveCount(0);

    await page.getByTestId(`requisition-remove-reason-${ids.fit}`).selectOption('SKILLS');
    await page.getByTestId(`requisition-remove-${ids.fit}`).click();
    await expect(page.getByTestId(`requisition-remove-${ids.fit}`)).toHaveCount(0);
    const app = await prisma.application.findUniqueOrThrow({ where: { requisitionId_menteeId: { requisitionId: ids.req, menteeId: ids.fit } } });
    expect(app).toMatchObject({ stage: 'REJECTED', dispositionCode: 'SKILLS' });
  });
});
