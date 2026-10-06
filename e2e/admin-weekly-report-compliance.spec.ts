import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Org-wide weekly-report compliance (#1917): GET /api/admin/weekly-reports and
// its per-intern detail. The arithmetic itself is unit-tested
// (scripts/test/weekly-report-compliance.test.mjs); this spec pins what only a
// real database can — who may read it, that it stays inside the caller's
// tenant, that only interning relations are listed, and that the numbers
// survive the trip through Prisma.

const PW = 'Compliance123!';
const DAY = 24 * 60 * 60 * 1000;
const STAGE = 'INTERNSHIP_IN_PROGRESS_450';

function monday(offsetWeeks: number) {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  return day;
}

test.describe('admin weekly-report compliance', () => {
  const stamp = `${Date.now()}`;
  const emails = {
    admin: uniqueEmail('wrc-admin'),
    mentor: uniqueEmail('wrc-mentor'),
    intern: uniqueEmail('wrc-intern'),
    fresh: uniqueEmail('wrc-fresh'),
    applicant: uniqueEmail('wrc-applicant'),
    otherMentor: uniqueEmail('wrc-other-mentor'),
    otherIntern: uniqueEmail('wrc-other-intern'),
  };
  const orgIds: string[] = [];
  let cohortId = '';
  let internRelationId = '';
  let freshRelationId = '';

  test.beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `WRC Org ${stamp}`, slug: `wrc-${stamp}` } });
    const other = await prisma.organization.create({ data: { name: `WRC Other ${stamp}`, slug: `wrc-other-${stamp}` } });
    orgIds.push(org.id, other.id);
    await seedUser(emails.admin, PW, 'ADMIN', `WRC Admin ${stamp}`, org.id);
    const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `WRC Mentor ${stamp}`, org.id);
    const intern = await seedUser(emails.intern, PW, 'MENTEE', `WRC A Intern ${stamp}`, org.id);
    const fresh = await seedUser(emails.fresh, PW, 'MENTEE', `WRC B Fresh ${stamp}`, org.id);
    const applicant = await seedUser(emails.applicant, PW, 'MENTEE', `WRC C Applicant ${stamp}`, org.id);
    const otherMentor = await seedUser(emails.otherMentor, PW, 'MENTOR', `WRC Other Mentor ${stamp}`, other.id);
    const otherIntern = await seedUser(emails.otherIntern, PW, 'MENTEE', `WRC Other Intern ${stamp}`, other.id);
    cohortId = (await prisma.cohort.create({ data: { name: `WRC Cohort ${stamp}`, orgId: org.id } })).id;

    // Entered the internship on a Tuesday five weeks ago: the four full weeks
    // since then are owed, the running week is not.
    const entered = new Date(monday(-5).getTime() + DAY);
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: intern.id, orgId: org.id, cohortId, pipelineStatus: STAGE, startDate: new Date(entered.getTime() - 14 * DAY) },
    });
    internRelationId = rel.id;
    await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: STAGE, createdAt: entered } });
    const report = (weekStart: Date, status: 'DRAFT' | 'SUBMITTED' | 'APPROVED', submittedAt: Date | null) =>
      prisma.weeklyReport.create({ data: { orgId: org.id, relationId: rel.id, weekStart, summary: 'e2e', status, submittedAt } });
    await report(monday(-4), 'APPROVED', new Date(monday(-4).getTime() + 4 * DAY)); // on time
    // monday(-3): nothing at all → missing
    await report(monday(-2), 'SUBMITTED', new Date(monday(-1).getTime() + 2 * DAY)); // handed in the week after → late
    await report(monday(-1), 'DRAFT', null); // a draft is not a submission → missing
    await report(monday(0), 'SUBMITTED', new Date()); // the running week: not owed, not counted

    // Started interning today: owes nothing yet.
    const freshRel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: fresh.id, orgId: org.id, cohortId, pipelineStatus: STAGE },
    });
    freshRelationId = freshRel.id;
    await prisma.statusChange.create({ data: { relationId: freshRel.id, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: STAGE, createdAt: new Date() } });

    // Never interned: not part of the compliance picture at all.
    await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: applicant.id, orgId: org.id, cohortId } });

    // Another tenant's intern.
    const otherRel = await prisma.mentorshipRelation.create({
      data: { mentorId: otherMentor.id, menteeId: otherIntern.id, orgId: other.id, pipelineStatus: STAGE, startDate: monday(-6) },
    });
    await prisma.weeklyReport.create({ data: { orgId: other.id, relationId: otherRel.id, weekStart: monday(-3), summary: 'other', status: 'SUBMITTED', submittedAt: monday(-3) } });
  });

  test.afterAll(async () => {
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.cohort.deleteMany({ where: { id: cohortId } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  test('an admin sees every intern of the cohort with honest counts, and nobody else’s', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    const res = await page.request.get(`/api/admin/weekly-reports?cohortId=${cohortId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    // The applicant never interned and the other tenant's intern is out of scope.
    expect(body.rows.map((r: { mentee: { fullName: string } }) => r.mentee.fullName)).toEqual([`WRC A Intern ${stamp}`, `WRC B Fresh ${stamp}`]);
    const [intern, fresh] = body.rows;
    expect(intern).toMatchObject({ expected: 4, submitted: 2, reviewed: 1, missing: 2, late: 1, rate: 0.5 });
    expect(intern.missingWeeks.map((w: string) => w.slice(0, 10))).toEqual([monday(-3), monday(-1)].map((d) => d.toISOString().slice(0, 10)));
    expect(intern.lateWeeks.map((w: string) => w.slice(0, 10))).toEqual([monday(-2).toISOString().slice(0, 10)]);
    // Owes nothing yet: null, never 0%.
    expect(fresh).toMatchObject({ expected: 0, missing: 0, rate: null });
    expect(body.rollUp).toMatchObject({ relations: 2, reporting: 1, behind: 1, expected: 4, submitted: 2, rate: 0.5 });

    // Without the cohort filter the tenant boundary still holds.
    const all = await (await page.request.get('/api/admin/weekly-reports')).json();
    expect(all.rows.some((r: { mentee: { fullName: string } }) => r.mentee.fullName.startsWith('WRC Other'))).toBe(false);

    // Paginated.
    const paged = await (await page.request.get(`/api/admin/weekly-reports?cohortId=${cohortId}&pageSize=1&page=2`)).json();
    expect(paged).toMatchObject({ total: 2, totalPages: 2, hasMore: false });
    expect(paged.rows).toHaveLength(1);
    expect(paged.rows[0].relationId).toBe(freshRelationId);
  });

  test('the detail lists each owed week with its state', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    const res = await page.request.get(`/api/admin/weekly-reports/${internRelationId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.weeks.map((w: { state: string; late: boolean }) => `${w.state}${w.late ? '+late' : ''}`)).toEqual([
      'approved', 'missing', 'submitted+late', 'draft',
    ]);
    // The running week's report is not hidden — it is listed apart.
    expect(body.otherReports).toHaveLength(1);
  });

  test('only admins read it; the mentor’s own single-relation access is unchanged', async ({ page }) => {
    await signInAndSettle(page, emails.mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/weekly-reports')).status()).toBe(403);
    expect((await page.request.get(`/api/admin/weekly-reports/${internRelationId}`)).status()).toBe(403);
    expect((await page.request.get(`/api/weekly-reports?relationId=${internRelationId}`)).status()).toBe(200);
  });
});
