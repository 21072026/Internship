import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';
import { setOrgFeatureFor } from './helpers/entitlements';

// The programme filter of /admin/analytics (#1652): free on every plan, the
// buckets add up to the tenant total, and another org's programme id is
// refused server-side. Tagged @smoke for the cross-tenant refusal.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'ProgramPass123!';
const DAY = 24 * 60 * 60 * 1000;

test('two programmes report different funnels; buckets add up; a foreign programme is a 404', { tag: '@smoke' }, async ({ page }) => {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Programme Org ${stamp}`, slug: `prog-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Other Org ${stamp}`, slug: `prog-other-${stamp}` } });
  const emails = {
    admin: uniqueEmail('pf-admin'),
    mentor: uniqueEmail('pf-mentor'),
    m1: uniqueEmail('pf-m1'),
    m2: uniqueEmail('pf-m2'),
    m3: uniqueEmail('pf-m3'),
    m4: uniqueEmail('pf-m4'),
  };
  await seedUser(emails.admin, PASSWORD, 'ADMIN', 'Programme Admin', org.id);
  const mentor = await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'Programme Mentor', org.id);
  const [m1, m2, m3, m4] = await Promise.all(
    [emails.m1, emails.m2, emails.m3, emails.m4].map((e, i) => seedUser(e, PASSWORD, 'MENTEE', `Programme Mentee ${i + 1}`, org.id)),
  );
  const spring = await prisma.cohort.create({ data: { name: `Spring ${stamp}`, term: '2026', orgId: org.id } });
  const autumn = await prisma.cohort.create({ data: { name: `Autumn ${stamp}`, term: '2026', orgId: org.id } });
  const foreign = await prisma.cohort.create({ data: { name: `Foreign ${stamp}`, orgId: other.id } });

  const start = new Date(Date.now() - 20 * DAY);
  const rel = (menteeId: string, cohortId: string | null, pipelineStatus: string) =>
    prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId, cohortId, pipelineStatus, startDate: start } });
  // Spring: one hired, one interviewing. Autumn: one interviewing. One with no programme.
  const rels = await Promise.all([
    rel(m1.id, spring.id, 'HIRED_660'),
    rel(m2.id, spring.id, 'INTERVIEW_PENDING_250'),
    rel(m3.id, autumn.id, 'INTERVIEW_PENDING_250'),
    rel(m4.id, null, 'APPLICATION_100'),
  ]);
  await prisma.statusChange.create({
    data: { relationId: rels[0].id, fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'HIRED_660', createdAt: new Date(start.getTime() + 5 * DAY) },
  });

  try {
    await signInAsFreshUser(page, emails.admin, PASSWORD, '/admin');
    const read = async (program?: string) => {
      const res = await page.request.get(`/api/admin/analytics${program ? `?program=${program}` : ''}`);
      expect(res.status()).toBe(200);
      return res.json();
    };
    const all = await read();
    const s = await read(spring.id);
    const a = await read(autumn.id);
    const u = await read('unassigned');

    // Two programmes, two different funnels.
    expect(s.totalRelations).toBe(2);
    expect(s.funnel.HIRED_660).toBe(1);
    expect(s.conversionToHired).toBe(50);
    expect(a.totalRelations).toBe(1);
    expect(a.funnel.HIRED_660 ?? 0).toBe(0);
    expect(a.conversionToHired).toBe(0);
    // Programmes + unassigned = the tenant total, stage by stage.
    expect(s.totalRelations + a.totalRelations + u.totalRelations).toBe(all.totalRelations);
    for (const key of Object.keys(all.funnel)) {
      expect((s.funnel[key] ?? 0) + (a.funnel[key] ?? 0) + (u.funnel[key] ?? 0)).toBe(all.funnel[key]);
    }
    // The selector's options are this tenant's programmes only.
    const ids = all.programs.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([spring.id, autumn.id]));
    expect(ids).not.toContain(foreign.id);

    // The funnel KPIs follow the filter too.
    const funnelS = await (await page.request.get(`/api/admin/analytics/funnel?program=${spring.id}`)).json();
    const funnelA = await (await page.request.get(`/api/admin/analytics/funnel?program=${autumn.id}`)).json();
    expect(funnelS.journeys).toBe(2);
    expect(funnelA.journeys).toBe(1);

    // Another org's programme, or garbage, is refused before any number is computed.
    for (const path of ['/api/admin/analytics', '/api/admin/analytics/funnel', '/api/admin/analytics/aging']) {
      expect((await page.request.get(`${path}?program=${foreign.id}`)).status()).toBe(404);
    }
    expect((await page.request.get(`/api/admin/analytics?program=${encodeURIComponent("x' OR 1=1")}`)).status()).toBe(404);

    // The single-programme filter is free; only the COMPARISON is premium.
    await setOrgFeatureFor(page, 'ADVANCED_ANALYTICS', false);
    expect((await page.request.get(`/api/admin/analytics?program=${spring.id}`)).status()).toBe(200);
    expect((await page.request.get('/api/admin/analytics/programs')).status()).toBe(403);
    await setOrgFeatureFor(page, 'ADVANCED_ANALYTICS', true);
    const cmp = await (await page.request.get('/api/admin/analytics/programs')).json();
    const rows = cmp.programs as { id: string; total: number }[];
    expect(rows.find((r) => r.id === spring.id)?.total).toBe(2);
    expect(rows.find((r) => r.id === autumn.id)?.total).toBe(1);
    expect(cmp.unassigned.total).toBe(1);
    // The old path still answers for one release, with its old key.
    const legacy = await (await page.request.get('/api/admin/analytics/cohorts')).json();
    expect(legacy.cohorts.map((r: { id: string }) => r.id)).toEqual(rows.map((r) => r.id));

    // The screen: choosing a programme puts it in the URL, and the link reopens it.
    await gotoSettled(page, '/admin/analytics');
    const filter = page.getByTestId('analytics-program-filter');
    await expect(filter).toBeVisible();
    await filter.selectOption(spring.id);
    await expect(page).toHaveURL(new RegExp(`program=${spring.id}`));
    await gotoSettled(page, `/admin/analytics?program=${autumn.id}`);
    await expect(page.getByTestId('analytics-program-filter')).toHaveValue(autumn.id);
  } finally {
    await setOrgFeatureFor(page, 'ADVANCED_ANALYTICS', false).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relationId: { in: rels.map((r) => r.id) } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: rels.map((r) => r.id) } } });
    await prisma.cohort.deleteMany({ where: { id: { in: [spring.id, autumn.id, foreign.id] } } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
