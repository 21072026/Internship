import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The skills-gap report (#1823): supply (what the org's mentees hold) against
// demand (what HIRING requisitions require), and the role gate that keeps it
// an admin report. The arithmetic is unit-tested in
// scripts/test/skills-gap.test.mjs; this pins the route end to end — which
// requisitions count, the cohort narrowing, the tenant boundary, the gate.

const PW = 'SkillsGap123!';
const stamp = Date.now();
let orgId = '';
let otherOrgId = '';
let companyId = '';
let cohortId = '';
const emails: Record<string, string> = {};

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Skills Gap ${stamp}`, slug: `skills-gap-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Skills Gap B ${stamp}`, slug: `skills-gap-b-${stamp}` } });
  orgId = org.id;
  otherOrgId = other.id;
  await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
  const skill = (key: string, label: string, inOrg = orgId) =>
    prisma.skill.create({ data: { orgId: inOrg, key, labelEn: label, labelTr: label, labelDe: label } });
  const [react, k8s, excel] = await Promise.all([skill('react', 'React'), skill('kubernetes', 'Kubernetes'), skill('excel', 'Excel')]);
  const foreign = await skill('cobol', 'COBOL', otherOrgId);

  for (const role of ['admin', 'mentor', 'mentee1', 'mentee2', 'company', 'source']) emails[role] = uniqueEmail(`gap-${role}`);
  const company = await prisma.company.create({ data: { name: `Gap Co ${stamp}`, industry: 'Software', orgId } });
  companyId = company.id;
  await seedUser(emails.admin, PW, 'ADMIN', 'Gap Admin', orgId);
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Gap Mentor', orgId);
  const m1 = await seedUser(emails.mentee1, PW, 'MENTEE', 'Gap Mentee One', orgId);
  const m2 = await seedUser(emails.mentee2, PW, 'MENTEE', 'Gap Mentee Two', orgId);
  await seedUser(emails.company, PW, 'COMPANY', 'Gap Company', orgId);
  await prisma.user.updateMany({ where: { email: emails.company }, data: { companyId } });
  await seedUser(emails.source, PW, 'SOURCE', 'Gap Source', orgId);

  // Supply: mentee1 holds React (4, confirmed) + Excel; mentee2 holds React (2).
  await prisma.userSkill.createMany({
    data: [
      { userId: m1.id, skillId: react.id, level: 4, levelSource: 'MENTOR', verifiedAt: new Date() },
      { userId: m1.id, skillId: excel.id },
      { userId: m2.id, skillId: react.id, level: 2, levelSource: 'SELF' },
    ],
  });
  // Cohort holds mentee2 only.
  const cohort = await prisma.cohort.create({ data: { orgId, name: `Gap Cohort ${stamp}` } });
  cohortId = cohort.id;
  await prisma.mentorshipRelation.create({ data: { orgId, mentorId: mentor.id, menteeId: m2.id, cohortId, status: 'ACTIVE' } });

  // Demand: one hiring requisition (React + Kubernetes, 3 seats, 1 filled)
  // and three that must NOT count — a draft, a fully staffed OPEN one, and a
  // hiring one in another org.
  const reqn = async (title: string, status: string, openings: number, filled: number, skills: string[], inOrg = orgId, co = companyId) => {
    const r = await prisma.requisition.create({ data: { orgId: inOrg, companyId: co, title, status, openings, filled } });
    if (skills.length) await prisma.requisitionSkill.createMany({ data: skills.map((skillId) => ({ requisitionId: r.id, skillId })) });
  };
  await reqn('Hiring', 'OPEN', 3, 1, [react.id, k8s.id]);
  await reqn('Draft', 'DRAFT', 9, 0, [k8s.id]);
  await reqn('Staffed', 'OPEN', 2, 2, [k8s.id]);
  const otherCo = await prisma.company.create({ data: { name: `Gap Other Co ${stamp}`, industry: 'Software', orgId: otherOrgId } });
  await reqn('Foreign', 'OPEN', 5, 0, [foreign.id], otherOrgId, otherCo.id);
});

test.afterAll(async () => {
  for (const email of Object.values(emails)) await cleanupByEmail(email);
  await prisma.requisition.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  await prisma.cohort.deleteMany({ where: { orgId } });
  await prisma.company.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.$disconnect();
});

test('skills-gap: only hiring requisitions are demand, ranked against the pool', async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
    const res = await admin.get('/api/admin/analytics/skills-gap');
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.hiringRequisitions).toBe(1);
    expect(body.supplyPeople).toBe(2);
    // 2 open seats need Kubernetes, nobody holds it; React: 2 seats − 2 people = 0.
    expect(body.underSupplied).toEqual([expect.objectContaining({ label: 'Kubernetes', gap: 2, holders: 0, demandOpenings: 2 })]);
    expect(body.unused).toEqual([expect.objectContaining({ label: 'Excel', holders: 1 })]);
    expect(body.coverage).toEqual({ covered: 0, total: 1, share: 0 });
    expect(JSON.stringify(body)).not.toContain('COBOL');

    // The cohort narrows supply to mentee2.
    const cohort = await (await admin.get(`/api/admin/analytics/skills-gap?cohortId=${cohortId}`)).json();
    expect(cohort.supplyPeople).toBe(1);
    expect(cohort.unused).toEqual([]);
    // Another tenant's (or a made-up) cohort is a 404.
    expect((await admin.get('/api/admin/analytics/skills-gap?cohortId=nope')).status()).toBe(404);
  } finally {
    await admin.dispose();
  }
});

test('skills-gap: every non-admin role is refused by the route', async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.get('/api/admin/analytics/skills-gap')).status()).toBe(401);
  await anon.dispose();
  for (const role of ['mentor', 'mentee1', 'company', 'source']) {
    const ctx = await playwright.request.newContext({ baseURL });
    try {
      expect((await signInViaApi(ctx, emails[role], PW)).ok, role).toBe(true);
      expect((await ctx.get('/api/admin/analytics/skills-gap')).status(), role).toBe(403);
    } finally {
      await ctx.dispose();
    }
  }
});

test('skills-gap: without ADVANCED_ANALYTICS the report is locked', async ({ playwright, baseURL }) => {
  await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', false);
  const admin = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
    const res = await admin.get('/api/admin/analytics/skills-gap');
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' });
  } finally {
    await admin.dispose();
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
  }
});
