import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #933: a backdated status change (a manual correction, or an import) can put
// the HIRED/EMPLOYED transition before the relation's startDate, producing a
// negative "days to hire". Both analytics routes must drop that row from the
// average instead of counting it as-is or zeroed, and report `null` when no
// valid duration remains.

test('mentor analytics excludes a negative-duration hire from the average', async ({ page }) => {
  const mentorEmail = uniqueEmail('negdur-mentor');
  const validEmail = uniqueEmail('negdur-valid');
  const negativeEmail = uniqueEmail('negdur-negative');
  const pw = 'NegDurPass123';

  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'NegDur Mentor');
  const validMentee = await seedUser(validEmail, 'x', 'MENTEE', 'NegDur Valid Mentee');
  const negativeMentee = await seedUser(negativeEmail, 'x', 'MENTEE', 'NegDur Negative Mentee');

  const validStart = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const validRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: validMentee.id, pipelineStatus: 'HIRED_660', startDate: validStart },
  });
  await prisma.statusChange.create({
    data: {
      relationId: validRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(validStart.getTime() + 10 * 24 * 60 * 60 * 1000),
    },
  });

  // Backdated: the HIRED transition is recorded 5 days before the relation's
  // own startDate — a negative duration that must not enter the average.
  const negativeStart = new Date();
  const negativeRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: negativeMentee.id, pipelineStatus: 'HIRED_660', startDate: negativeStart },
  });
  await prisma.statusChange.create({
    data: {
      relationId: negativeRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(negativeStart.getTime() - 5 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.get('/api/mentor/analytics');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.hired).toBe(2);
    // Only the valid (10-day) hire counts — not (10 + -5) / 2 and not (10 + 0) / 2.
    expect(data.avgDaysToHired).toBe(10);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(validEmail);
    await cleanupByEmail(negativeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentor analytics reports null when every hire has a negative duration', async ({ page }) => {
  const mentorEmail = uniqueEmail('negdur-onlyneg-mentor');
  const menteeEmail = uniqueEmail('negdur-onlyneg-mentee');
  const pw = 'NegDurPass123';

  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'NegDur OnlyNeg Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'NegDur OnlyNeg Mentee');

  const start = new Date();
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'HIRED_660', startDate: start },
  });
  await prisma.statusChange.create({
    data: {
      relationId: rel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(start.getTime() - 3 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.get('/api/mentor/analytics');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.hired).toBe(1);
    expect(data.avgDaysToHired).toBeNull();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('admin cohort comparison excludes a negative-duration hire and reports null when none are valid', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('negdur-cohort-admin');
  const mentorEmail = uniqueEmail('negdur-cohort-mentor');
  const validEmail = uniqueEmail('negdur-cohort-valid');
  const negativeEmail = uniqueEmail('negdur-cohort-negative');
  const onlyNegEmail = uniqueEmail('negdur-cohort-onlyneg');
  const pw = 'NegDurPass123';

  await seedUser(adminEmail, pw, 'ADMIN', 'NegDur Cohort Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'NegDur Cohort Mentor');
  const validMentee = await seedUser(validEmail, 'x', 'MENTEE', 'NegDur Cohort Valid Mentee');
  const negativeMentee = await seedUser(negativeEmail, 'x', 'MENTEE', 'NegDur Cohort Negative Mentee');
  const onlyNegMentee = await seedUser(onlyNegEmail, 'x', 'MENTEE', 'NegDur Cohort OnlyNeg Mentee');

  const mixedCohort = await prisma.cohort.create({ data: { name: `NegDur Mixed ${stamp}` } });
  const onlyNegativeCohort = await prisma.cohort.create({ data: { name: `NegDur OnlyNeg ${stamp}` } });

  const validStart = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const validRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: validMentee.id, cohortId: mixedCohort.id, pipelineStatus: 'HIRED_660', startDate: validStart },
  });
  await prisma.statusChange.create({
    data: {
      relationId: validRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(validStart.getTime() + 15 * 24 * 60 * 60 * 1000),
    },
  });

  const negativeStart = new Date();
  const negativeRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: negativeMentee.id, cohortId: mixedCohort.id, pipelineStatus: 'HIRED_660', startDate: negativeStart },
  });
  await prisma.statusChange.create({
    data: {
      relationId: negativeRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(negativeStart.getTime() - 4 * 24 * 60 * 60 * 1000),
    },
  });

  const onlyNegStart = new Date();
  const onlyNegRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: onlyNegMentee.id, cohortId: onlyNegativeCohort.id, pipelineStatus: 'HIRED_660', startDate: onlyNegStart },
  });
  await prisma.statusChange.create({
    data: {
      relationId: onlyNegRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id,
      createdAt: new Date(onlyNegStart.getTime() - 2 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const enable = await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });
    expect(enable.ok()).toBeTruthy();

    const res = await page.request.get('/api/admin/analytics/cohorts');
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()).cohorts as { id: string; hired: number; avgDaysToHired: number | null }[];

    const mixed = rows.find((r) => r.id === mixedCohort.id);
    expect(mixed).toBeTruthy();
    expect(mixed!.hired).toBe(2);
    // Only the valid (15-day) hire counts, not the backdated one.
    expect(mixed!.avgDaysToHired).toBe(15);

    const onlyNeg = rows.find((r) => r.id === onlyNegativeCohort.id);
    expect(onlyNeg).toBeTruthy();
    expect(onlyNeg!.hired).toBe(1);
    expect(onlyNeg!.avgDaysToHired).toBeNull();
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { cohortId: { in: [mixedCohort.id, onlyNegativeCohort.id] } } });
    await prisma.cohort.deleteMany({ where: { id: { in: [mixedCohort.id, onlyNegativeCohort.id] } } });
    await cleanupByEmail(validEmail);
    await cleanupByEmail(negativeEmail);
    await cleanupByEmail(onlyNegEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
