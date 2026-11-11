import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1504: placement numbers count PLACEMENT relations whose hire is ours. Its
// own org, on the built-in stage catalogue.
//   • with every relation PLACEMENT and no attribution stated — every row from
//     before #1503 — the numbers are exactly the old formula;
//   • a COACHING pair leaves both sides of the rate and the funnel, a
//     SELF_FOUND hire stays a relation but is not a placement; the mentor's
//     workload still counts every pairing.
test('coaching and self-found hires do not move the placement numbers', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const pw = 'PlacementPass123!';
  const org = await prisma.organization.create({ data: { name: `Placement ${stamp}`, slug: `placement-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('pl-admin');
    const mentorEmail = uniqueEmail('pl-mentor');
    await seedUser(adminEmail, pw, 'ADMIN', 'PL Admin', org.id);
    const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'PL Mentor', org.id);
    const relation = async (pipelineStatus: string, extra: { kind?: string; employmentAttribution?: string } = {}) => {
      const mentee = await seedUser(uniqueEmail('pl-mentee'), 'x', 'MENTEE', 'PL Mentee', org.id);
      return prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus, ...extra } });
    };
    await relation('HIRED_660');
    await relation('EMPLOYED_700');
    await relation('APPLICATION_100');

    expect((await signInViaApi(page.request, adminEmail, pw)).ok).toBe(true);
    const read = async () => {
      const d = await (await page.request.get('/api/admin/analytics')).json();
      const me = (d.mentorWorkload as { id: string; active: number; hired: number }[]).find((m) => m.id === mentor.id);
      return { total: d.totalRelations, conversion: d.conversionToHired, funnel: d.funnel, workload: me };
    };

    // Before: the old formula — 2 hires over 3 relations.
    const before = await read();
    expect(before).toMatchObject({ total: 3, conversion: 67, funnel: { HIRED_660: 1, EMPLOYED_700: 1, APPLICATION_100: 1 }, workload: { active: 3, hired: 2 } });

    // A coaching pair on a "hired" stage and a self-found hire.
    await relation('HIRED_660', { kind: 'COACHING' });
    await relation('HIRED_660', { employmentAttribution: 'SELF_FOUND' });
    const after = await read();
    // The self-found hire is a placement relation (denominator), not a placement;
    // the coaching pair is in neither side, nor in the funnel.
    expect(after).toMatchObject({ total: 4, conversion: 50, funnel: { HIRED_660: 2, EMPLOYED_700: 1, APPLICATION_100: 1 }, workload: { active: 5, hired: 2 } });

    // The mentor's own numbers apply the same rule.
    await page.context().clearCookies();
    expect((await signInViaApi(page.request, mentorEmail, pw)).ok).toBe(true);
    const mine = await (await page.request.get('/api/mentor/analytics')).json();
    expect({ conversion: mine.conversionToHired, hiredStage: mine.funnel.HIRED_660 }).toEqual({ conversion: 50, hiredStage: 2 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
