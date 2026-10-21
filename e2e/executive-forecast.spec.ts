import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// The forecast and capacity panel on /admin/analytics/executive (#1897), on an
// org with its own three-stage pipeline so every number is worked by hand:
//
//   History (started 100 days ago, all closed): 20 entered "Applied", 10 moved
//   to "Interviewing" 30 days later, 5 of those reached "Signed on" 30 days
//   after that — each step 50%, each median dwell 30 days.
//   Today: 4 active in "Applied", 2 in "Interviewing". The open ones count
//   only for stages they have left, so the 2 in "Interviewing" add to Applied's
//   advances: Applied 12 of 22, Interviewing 5 of 10.
//   Placements by a six-month horizon: 4 × 12/22 × .5 + 2 × .5 = 2.1 of 6.
//   Capacity: one mentor with a stated capacity of 1 → 1 seat × horizon days.
//   Needed: Applied 4 × 30 = 120, Interviewing 2 × 30 + 4 × 12/22 × 30 = 125 —
//   245 mentee-days over 182-ish available, so "Interviewing" is where it runs
//   out and one more mentor covers it.
//
// A second org has three journeys of history: below the floor, so it refuses.

const PW = 'AdminForecast123!';
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

test.describe('executive forecast panel', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('fc-admin');
  const thinAdmin = uniqueEmail('fc-thin-admin');
  const lockedAdmin = uniqueEmail('fc-locked-admin');
  const mentor = uniqueEmail('fc-mentor');
  const emails: string[] = [admin, thinAdmin, lockedAdmin, mentor];
  const orgIds: string[] = [];

  async function seedOrg(name: string, history: { reached: number }[], today: Record<string, number>, mentorEmail?: string) {
    const orgId = (await prisma.organization.create({ data: { name: `${name} ${stamp}`, slug: `${name.toLowerCase()}-${stamp}` } })).id;
    orgIds.push(orgId);
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await prisma.pipelineStage.createMany({
      data: [
        { orgId, key: 'FC_APPLIED', label: 'Applied', order: 0 },
        { orgId, key: 'FC_INTERVIEW', label: 'Interviewing', order: 1 },
        { orgId, key: 'FC_SIGNED', label: 'Signed on', order: 2, isTerminal: true },
      ],
    });
    const m = await seedUser(mentorEmail ?? uniqueEmail('fc-m'), PW, 'MENTOR', `FC Mentor ${name} ${stamp}`, orgId);
    if (!mentorEmail) emails.push(m.email);
    await prisma.user.update({ where: { id: m.id }, data: { mentorCapacity: 1 } });
    const keys = ['FC_APPLIED', 'FC_INTERVIEW', 'FC_SIGNED'];
    let n = 0;
    const mentee = async () => {
      const email = uniqueEmail(`fc-e-${name}-${n++}`);
      emails.push(email);
      return seedUser(email, PW, 'MENTEE', `FC Mentee ${name} ${n} ${stamp}`, orgId);
    };
    for (const h of history) {
      const e = await mentee();
      const rel = await prisma.mentorshipRelation.create({
        data: { orgId, mentorId: m.id, menteeId: e.id, startDate: ago(100), status: 'COMPLETED', completedAt: ago(10), pipelineStatus: keys[h.reached] },
      });
      for (let s = 1; s <= h.reached; s++) {
        await prisma.statusChange.create({
          data: { relationId: rel.id, fromStatus: keys[s - 1], toStatus: keys[s], createdAt: ago(100 - 30 * s) },
        });
      }
    }
    for (const [key, count] of Object.entries(today)) {
      for (let i = 0; i < count; i++) {
        const e = await mentee();
        await prisma.mentorshipRelation.create({
          data: { orgId, mentorId: m.id, menteeId: e.id, startDate: ago(2), status: 'ACTIVE', pipelineStatus: key },
        });
      }
    }
    return orgId;
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const history = [
      ...Array.from({ length: 10 }, () => ({ reached: 0 })),
      ...Array.from({ length: 5 }, () => ({ reached: 1 })),
      ...Array.from({ length: 5 }, () => ({ reached: 2 })),
    ];
    const orgId = await seedOrg('Forecast', history, { FC_APPLIED: 4, FC_INTERVIEW: 2 }, mentor);
    await seedUser(admin, PW, 'ADMIN', `FC Admin ${stamp}`, orgId);
    const thinOrg = await seedOrg('Thin', [{ reached: 0 }, { reached: 1 }, { reached: 2 }], { FC_APPLIED: 1 });
    await seedUser(thinAdmin, PW, 'ADMIN', `FC Thin Admin ${stamp}`, thinOrg);
    const lockedOrg = (await prisma.organization.create({ data: { name: `FC Locked ${stamp}`, slug: `fc-locked-${stamp}` } })).id;
    orgIds.push(lockedOrg);
    await seedUser(lockedAdmin, PW, 'ADMIN', `FC Locked Admin ${stamp}`, lockedOrg);
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
    for (const email of emails) await cleanupByEmail(email);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.$disconnect();
  });

  test('the sentence, the bottleneck and the arithmetic, in the tenant’s own stage names', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');

    const api = await (await page.request.get('/api/admin/analytics/forecast')).json();
    expect(api.finishedKey).toBe('FC_SIGNED');
    expect(api.placements).toMatchObject({ status: 'ok', population: 6, expected: 2.1 });
    expect(api.placements.steps.map((s: { key: string; entered: number; advanced: number; medianDwellDays: number }) => [s.key, s.entered, s.advanced, s.medianDwellDays])).toEqual([
      ['FC_APPLIED', 22, 12, 30],
      ['FC_INTERVIEW', 10, 5, 30],
    ]);
    expect(api.capacity).toMatchObject({ status: 'ok', requiredDays: 245, bottleneck: 'FC_INTERVIEW', additionalMentors: 1 });

    await page.goto('/admin/analytics/executive');
    const panel = page.getByTestId('executive-forecast');
    await expect(page.getByTestId('executive-forecast-sentence')).toContainText(
      'At your current conversion rate, about 2 of the 6 records in the pipeline today reach “Signed on” by',
    );
    await expect(page.getByTestId('executive-forecast-capacity')).toContainText('“Interviewing” is where mentor capacity runs out. Mentors to add to carry everyone through to');
    await expect(page.getByTestId('executive-forecast-capacity')).toContainText(': about 1.');
    await page.getByTestId('executive-forecast-how').click();
    await expect(page.getByTestId('executive-forecast-row-FC_APPLIED')).toContainText('12 of 22');
    await expect(page.getByTestId('executive-forecast-row-FC_APPLIED')).toContainText('4 × 0.273 = 1.1');
    await expect(page.getByTestId('executive-forecast-capacity-line')).toContainText('245 mentee-days needed');
    // Plain arithmetic, and the panel never claims to be anything else.
    expect(await panel.innerText()).not.toMatch(/predict|learn|model/i);

    // A horizon too close for anyone to finish counts nobody.
    const soon = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    await page.getByTestId('executive-forecast-horizon').fill(soon);
    await expect(page.getByTestId('executive-forecast-sentence')).toContainText('about 0 of the 6 records');
  });

  test('below the sample-size floor it refuses and says why', async ({ page }) => {
    await signInAndSettle(page, thinAdmin, PW, '/admin');
    const api = await (await page.request.get('/api/admin/analytics/forecast')).json();
    expect(api.placements.status).toBe('insufficient');
    await page.goto('/admin/analytics/executive');
    await expect(page.getByTestId('executive-forecast-insufficient')).toContainText('at least 10 journeys');
    await expect(page.getByTestId('executive-forecast-insufficient')).toContainText('Applied (3)');
    await expect(page.getByTestId('executive-forecast-sentence')).toHaveCount(0);
  });

  test('403 without ADVANCED_ANALYTICS', async ({ page }) => {
    await signInAndSettle(page, lockedAdmin, PW, '/admin');
    const res = await page.request.get('/api/admin/analytics/forecast');
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' });
  });
});
