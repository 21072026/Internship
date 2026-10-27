import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, userInWorld } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1640 — per-cohort and per-mentor service levels.
//
// Precedence is mentor+cohort → mentor → cohort → org (src/lib/stageSlaRule.ts,
// unit-tested). This spec pins the part a unit test cannot: that a real stage
// move picks the relation's OWN override, and that the write path refuses a
// cohort or mentor id that is not the admin's org.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;
const STAGE = 'APPROVAL_PENDING_220';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor override beats a cohort override, which beats the org', async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { orgId: true });
  const orgId = admin?.orgId ?? null;
  test.skip(!orgId, 'needs an admin bound to an organisation');
  const org = orgId as string;

  const emails: string[] = [];
  const user = async (prefix: string, role: 'MENTOR' | 'MENTEE') => {
    const email = uniqueEmail(prefix);
    emails.push(email);
    const u = await seedUser(email, 'Pass123!x', role, `SLA ${prefix}`);
    await prisma.user.update({ where: { id: u.id }, data: { orgId } });
    return u;
  };
  const busy = await user('sla-ov-busy', 'MENTOR');
  const other = await user('sla-ov-other', 'MENTOR');
  const cohort = await prisma.cohort.create({ data: { name: `SLA fast track ${Date.now()}`, orgId } });
  const pair = async (mentorId: string, cohortId: string | null) => {
    const mentee = await user('sla-ov-mentee', 'MENTEE');
    return prisma.mentorshipRelation.create({
      data: { mentorId, menteeId: mentee.id, orgId, cohortId, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
  };
  const plain = await pair(other.id, null); // org: 7
  const inCohort = await pair(other.id, cohort.id); // cohort: 3
  const busyInCohort = await pair(busy.id, cohort.id); // mentor: 20 beats cohort: 3

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const put = (data: object) => page.request.put('/api/admin/stage-sla', { data });
    expect((await put({ slas: [{ stageKey: STAGE, days: 7 }] })).ok()).toBeTruthy();
    expect((await put({ cohortId: cohort.id, slas: [{ stageKey: STAGE, days: 3 }] })).ok()).toBeTruthy();
    expect((await put({ mentorId: busy.id, slas: [{ stageKey: STAGE, days: 20 }] })).ok()).toBeTruthy();

    // The editor's read shows the effective value and where it is inherited from.
    const view = await (await page.request.get(`/api/admin/stage-sla?cohortId=${cohort.id}&mentorId=${busy.id}`)).json();
    const row = view.stages.find((s: { key: string }) => s.key === STAGE);
    expect(row.days).toBeNull();
    expect(row.effective).toEqual({ days: 20, source: 'mentor' });
    expect(row.inherited).toEqual({ days: 20, source: 'mentor' });
    // The org view still answers the org's own number.
    const orgView = await (await page.request.get('/api/admin/stage-sla')).json();
    expect(orgView.stages.find((s: { key: string }) => s.key === STAGE).days).toBe(7);

    for (const rel of [plain, inCohort, busyInCohort]) {
      const moved = await page.request.put(`/api/mentorship/${rel.id}`, { data: { pipelineStatus: STAGE } });
      expect(moved.ok()).toBeTruthy();
    }
    const deadlineDays = async (id: string) => {
      const r = await prisma.mentorshipRelation.findUnique({ where: { id }, select: { stageDeadline: true } });
      return Math.round(((r?.stageDeadline?.getTime() ?? 0) - Date.now()) / DAY);
    };
    expect(await deadlineDays(plain.id)).toBe(7);
    expect(await deadlineDays(inCohort.id)).toBe(3);
    expect(await deadlineDays(busyInCohort.id)).toBe(20);

    // Another org's ids — or a mentee posing as a mentor — are refused server-side.
    const foreign = await prisma.cohort.create({ data: { name: 'SLA foreign', orgId: null } });
    try {
      expect((await put({ cohortId: foreign.id, slas: [{ stageKey: STAGE, days: 1 }] })).status()).toBe(404);
      expect((await put({ mentorId: plain.menteeId, slas: [{ stageKey: STAGE, days: 1 }] })).status()).toBe(404);
      expect((await page.request.get(`/api/admin/stage-sla?cohortId=${foreign.id}`)).status()).toBe(404);
    } finally {
      await prisma.cohort.delete({ where: { id: foreign.id } });
    }
    expect(await prisma.stageSla.count({ where: { orgId: org, cohortId: foreign.id } })).toBe(0);
  } finally {
    await prisma.stageSla.deleteMany({ where: { orgId: org } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [plain.id, inCohort.id, busyInCohort.id] } } });
    await prisma.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    for (const email of emails) await cleanupByEmail(email);
  }
});
