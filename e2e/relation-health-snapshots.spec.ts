import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Relationship-health snapshots and the at-risk digest (#1901). Its own org,
// so the sweep (scoped to the caller's org by GET /api/cron) touches nothing
// else. SMTP is unset in CI: the EmailLog row a skipped send still writes is
// what says who got the digest, under which subject.

const PW = 'HealthSweep123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('relationship-health snapshots', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('rh-admin');
  const mentor = uniqueEmail('rh-mentor');
  const mentee = uniqueEmail('rh-mentee');
  let orgId = '';
  let relationId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `RH Org ${stamp}`, slug: `rh-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `RH Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `RH Mentor ${stamp}`, orgId);
    const e = await seedUser(mentee, PW, 'MENTEE', `RH Mentee ${stamp}`, orgId);
    // A pair in trouble: started 200 days ago, never in touch, its stage
    // deadline passed, nothing open, never moved stage.
    relationId = (
      await prisma.mentorshipRelation.create({
        data: {
          orgId,
          mentorId: m.id,
          menteeId: e.id,
          pipelineStatus: 'INTERVIEW_PENDING_250',
          startDate: new Date(Date.now() - 200 * DAY),
          stageDeadline: new Date(Date.now() - 5 * DAY),
        },
      })
    ).id;
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: admin } });
    await prisma.relationHealthSnapshot.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('one snapshot per day, one alert per crossing, and a readable trend', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const today = new Date();
    const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const sweep = async (at?: Date) =>
      (await (await page.request.get(`/api/cron?job=relation-health${at ? `&at=${at.toISOString()}` : ''}`)).json()).relationHealth;
    const digests = () => prisma.emailLog.findMany({ where: { to: admin, category: 'program-health' }, select: { subject: true } });

    // Yesterday the pair was fine.
    await prisma.relationHealthSnapshot.create({
      data: { orgId, relationId, takenOn: new Date(midnight.getTime() - DAY), score: 80, band: 'HEALTHY', reasons: [], rulesVersion: 1 },
    });

    // Tonight it crossed into AT_RISK: one snapshot, one digest naming it.
    const first = await sweep();
    expect(first).toMatchObject({ scored: 1, crossings: 1, mailed: 1 });
    const snap = await prisma.relationHealthSnapshot.findUnique({ where: { relationId_takenOn: { relationId, takenOn: midnight } } });
    expect(snap?.band).toBe('AT_RISK');
    expect(snap?.reasons).toEqual(expect.arrayContaining(['inactive', 'overdue', 'no_open_goal']));
    expect(snap?.alertedAt).not.toBeNull();
    const mails = await digests();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^1 relationship\(s\) need attention — /);

    // A second run the same day: still one row, no second mail.
    const again = await sweep();
    expect(again).toMatchObject({ scored: 1, crossings: 0 });
    expect(await prisma.relationHealthSnapshot.count({ where: { relationId, takenOn: midnight } })).toBe(1);
    expect(await digests()).toHaveLength(1);

    // Tomorrow it is still red: a snapshot, but no alert while it stays red.
    const tomorrow = await sweep(new Date(today.getTime() + DAY));
    expect(tomorrow).toMatchObject({ scored: 1, crossings: 0 });
    expect(await prisma.relationHealthSnapshot.count({ where: { relationId } })).toBe(3);
    expect(await digests()).toHaveLength(1);

    // Snapshots past the retention window are pruned by the same sweep.
    await prisma.relationHealthSnapshot.create({
      data: { orgId, relationId, takenOn: new Date(midnight.getTime() - 200 * DAY), score: 90, band: 'HEALTHY', reasons: [], rulesVersion: 1 },
    });
    expect((await sweep()).pruned).toBeGreaterThanOrEqual(1);
    expect(await prisma.relationHealthSnapshot.count({ where: { relationId, takenOn: { lt: new Date(midnight.getTime() - 180 * DAY) } } })).toBe(0);

    // The trend: a dated series and the deltas, numbers only.
    const trend = await (await page.request.get(`/api/admin/relation-health/${relationId}?days=30`)).json();
    expect(trend.series.map((p: { day: string }) => p.day)).toEqual([
      new Date(midnight.getTime() - DAY).toISOString().slice(0, 10),
      midnight.toISOString().slice(0, 10),
    ]);
    expect(trend.latest).toMatchObject({ band: 'AT_RISK' });
    expect(trend).toHaveProperty('delta7');
    expect(trend).toHaveProperty('delta30');
  });

  test('another tenant cannot read a relationship’s health', async ({ page }) => {
    const other = uniqueEmail('rh-other-admin');
    const otherOrg = await prisma.organization.create({ data: { name: `RH Other ${stamp}`, slug: `rh-other-${stamp}` } });
    try {
      await seedUser(other, PW, 'ADMIN', 'RH Other Admin', otherOrg.id);
      await signInAndSettle(page, other, PW, '/admin');
      expect((await page.request.get(`/api/admin/relation-health/${relationId}`)).status()).toBe(404);
    } finally {
      await cleanupByEmail(other);
      await prisma.organization.deleteMany({ where: { id: otherOrg.id } });
    }
  });
});
