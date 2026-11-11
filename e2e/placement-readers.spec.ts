import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// #3472: the remaining hire counters read the one placement rule
// (src/lib/placement.ts). Its own org, on the built-in stage catalogue, with
// the premium analytics on. One relation hired THROUGH US (attribution not
// stated, like every row from before #1503) and one still applying make the
// baseline; then a COACHING pair and a SELF_FOUND hire — both on a hired stage,
// both inside the window, both referred by the same source — are added. The
// forecast, the ROI hire count, the source's outcomes and the mentor's outcome
// must read exactly what they read before; the mentor's workload (people
// mentored) still counts every pairing.

const PW = 'PlacementReaders123!';
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

test('coaching pairs and self-found hires leave every hire counter where it was', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `PR Readers ${stamp}`, slug: `pr-readers-${stamp}` } });
  const emails = { admin: uniqueEmail('prr-admin'), mentor: uniqueEmail('prr-mentor'), rep: uniqueEmail('prr-rep') };
  const mentees: string[] = [];
  try {
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);
    const source = await prisma.source.create({ data: { name: `PR Source ${stamp}`, orgId: org.id } });
    await seedUser(emails.admin, PW, 'ADMIN', 'PRR Admin', org.id);
    const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'PRR Mentor', org.id);
    await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10 } });
    const rep = await seedUser(emails.rep, PW, 'SOURCE', 'PRR Rep', org.id);
    await prisma.user.update({ where: { id: rep.id }, data: { sourceId: source.id } });
    await prisma.programCost.create({
      data: { orgId: org.id, category: 'STAFF', label: 'Coordinator', amountMinor: 1_000_000, currency: 'EUR', periodStart: ago(90), periodEnd: ago(-30) },
    });

    // One relation hired 10 days ago, through its stage trail, and one still applying.
    const relation = async (pipelineStatus: string, extra: { kind?: string; employmentAttribution?: string } = {}) => {
      const email = uniqueEmail('prr-mentee');
      mentees.push(email);
      const mentee = await seedUser(email, PW, 'MENTEE', 'PRR Mentee', org.id);
      await prisma.user.update({ where: { id: mentee.id }, data: { sourceId: source.id, createdAt: ago(60) } });
      const rel = await prisma.mentorshipRelation.create({
        data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus, startDate: ago(60), ...extra },
      });
      if (pipelineStatus === 'HIRED_660') {
        await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', createdAt: ago(10) } });
      }
      return rel;
    };
    await relation('HIRED_660');
    await relation('APPLICATION_100');

    const readAdmin = async () => {
      const forecast = await (await page.request.get('/api/admin/analytics/forecast')).json();
      const roi = await (await page.request.get('/api/admin/analytics/roi')).json();
      return { forecast, roiHires: roi.result?.placementCount };
    };
    const readSource = async () => {
      const o = await (await page.request.get('/api/source/outcomes')).json();
      return { placed: o.placed, timeToPlacement: o.timeToPlacement };
    };
    const readMentor = async () => {
      await gotoSettled(page, '/mentor');
      const card = page.getByTestId('mentor-impact-card');
      await expect(card).toBeVisible({ timeout: 60_000 });
      return {
        mentored: await card.getByTestId('mentor-impact-mentored-value').textContent(),
        outcome: await card.getByTestId('mentor-impact-outcome-value').textContent(),
        internship: await card.getByTestId('mentor-impact-internship-value').textContent(),
      };
    };

    // ── Before ────────────────────────────────────────────────────────────────
    await signInAndSettle(page, emails.admin, PW, '/admin');
    const adminBefore = await readAdmin();
    expect(adminBefore.roiHires).toBe(1);
    await page.context().clearCookies();
    await signInAndSettle(page, emails.rep, PW, '/source');
    const sourceBefore = await readSource();
    expect(sourceBefore.placed).toBe(1);
    await page.context().clearCookies();
    await signInAndSettle(page, emails.mentor, PW, '/mentor');
    const mentorBefore = await readMentor();
    expect(mentorBefore).toMatchObject({ mentored: '2', outcome: '1 of 2' });

    // ── A coaching pair and a self-found hire, both "hired" in the window ────
    await relation('HIRED_660', { kind: 'COACHING' });
    await relation('HIRED_660', { employmentAttribution: 'SELF_FOUND' });

    // ── After: every hire counter reads what it read ─────────────────────────
    const mentorAfter = await readMentor();
    // Workload counts every pairing; the outcome counts placements that are ours.
    expect(mentorAfter.mentored).toBe('4');
    expect(mentorAfter.outcome).toBe('1 of 4');
    await page.context().clearCookies();
    await signInAndSettle(page, emails.rep, PW, '/source');
    // Two more PEOPLE were referred (the denominator), but nobody more was placed.
    const sourceAfter = await readSource();
    expect(sourceAfter.placed).toBe(sourceBefore.placed);
    expect(sourceAfter.timeToPlacement).toEqual({ ...sourceBefore.timeToPlacement, considered: sourceBefore.timeToPlacement.considered + 2 });
    await page.context().clearCookies();
    await signInAndSettle(page, emails.admin, PW, '/admin');
    const adminAfter = await readAdmin();
    expect(adminAfter.roiHires).toBe(adminBefore.roiHires);
    // The forecast learns from and projects our placements only: the whole
    // payload is unchanged.
    expect(adminAfter.forecast).toEqual(adminBefore.forecast);
  } finally {
    await prisma.programCost.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const email of [...Object.values(emails), ...mentees]) await cleanupByEmail(email);
    await prisma.source.deleteMany({ where: { orgId: org.id } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
