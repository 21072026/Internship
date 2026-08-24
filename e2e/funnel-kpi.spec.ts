import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { biggestDropOff, stageConversions, timeToHire, type Journey } from '../src/lib/funnelKpi';

// #815 — hiring-funnel KPIs.
//
// Both numbers here are the kind that fail silently rather than loudly: a
// conversion rate computed against a hardcoded stage order is wrong on a custom
// pipeline, and a time-to-hire that quietly includes unfinished journeys
// describes a population nobody asked about. The arithmetic is therefore pinned
// exactly against constructed journeys, and the endpoint/screen are checked for
// the behaviour that arithmetic is supposed to produce.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const ORDER = ['s1', 's2', 's3', 's4'];

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('conversion and time-to-hire arithmetic: skips count, empty stages report no data, unfinished journeys are excluded', async () => {
  const journeys: Journey[] = [
    // Finished, and it SKIPPED s2 — a journey that jumped over a stage still
    // passed it, so s2 must not treat it as neither entered nor advanced.
    { startStatus: 's1', startedAt: T0, changes: [
      { toStatus: 's3', at: T0 + 10 * DAY },
      { toStatus: 's4', at: T0 + 20 * DAY },
    ] },
    // Finished the slow way.
    { startStatus: 's1', startedAt: T0, changes: [
      { toStatus: 's2', at: T0 + 5 * DAY },
      { toStatus: 's3', at: T0 + 20 * DAY },
      { toStatus: 's4', at: T0 + 40 * DAY },
    ] },
    // Still moving: reached s2 and stopped.
    { startStatus: 's1', startedAt: T0, changes: [{ toStatus: 's2', at: T0 + 3 * DAY }] },
    // Never moved at all.
    { startStatus: 's1', startedAt: T0, changes: [] },
  ];

  const conv = stageConversions(ORDER, journeys);
  const at = (key: string) => conv.find((c) => c.key === key)!;

  // All four reached s1; three got further.
  expect(at('s1')).toMatchObject({ entered: 4, advanced: 3, rate: 75 });
  // Three are at s2 or beyond — including the one that skipped s2 outright —
  // and two of those went further.
  expect(at('s2')).toMatchObject({ entered: 3, advanced: 2, rate: 67 });
  expect(at('s3')).toMatchObject({ entered: 2, advanced: 2, rate: 100 });
  // The final stage: reached, nothing beyond. There is no conversion to state —
  // "0% advanced" from the end of the funnel would describe people who
  // FINISHED, which is the misreading this KPI exists to prevent.
  expect(at('s4')).toMatchObject({ entered: 2, advanced: 0, rate: null, terminal: true });

  // A stage nobody reached reports NO DATA. 0% would claim everyone dropped out
  // of a stage nobody was ever in.
  const empty = stageConversions([...ORDER, 's5'], journeys);
  expect(empty.find((c) => c.key === 's5')).toMatchObject({ entered: 0, rate: null });

  // The biggest absolute loss is s1 → s2 (one person), NOT s4 — where two
  // journeys "failed to advance" only because they had arrived. Left in, the
  // terminal stage wins this comparison almost every time and points HR at the
  // one place nothing is wrong.
  expect(biggestDropOff(conv)?.key).toBe('s1');

  // Time-to-hire: 20 and 40 days for the two finished journeys → median 30,
  // average 30. The two unfinished ones are excluded, and the returned
  // population says so instead of the caller having to guess.
  const tth = timeToHire(ORDER, journeys);
  expect(tth).toMatchObject({
    completionKey: 's4',
    completed: 2,
    considered: 4,
    medianDays: 30,
    avgDays: 30,
  });

  // No journeys at all: nothing divides by zero, nothing is invented.
  expect(timeToHire(ORDER, [])).toMatchObject({ completed: 0, medianDays: null, avgDays: null });
  expect(biggestDropOff(stageConversions(ORDER, []))).toBeNull();
});

test('the funnel endpoint reports seeded journeys, and the screen states the population it measured', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('kpi-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'KPI Mentor');
  const menteeEmails: string[] = [];
  const start = new Date(Date.now() - 60 * DAY);

  const makeJourney = async (name: string, hops: { to: string; dayOffset: number }[]) => {
    const email = uniqueEmail(`kpi-${name}`);
    menteeEmails.push(email);
    const mentee = await seedUser(email, 'MenteePass123', 'MENTEE', `KPI ${name}`);
    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id,
        menteeId: mentee.id,
        orgId: mentee.orgId,
        status: 'ACTIVE',
        startDate: start,
        pipelineStatus: hops.length ? hops[hops.length - 1].to : 'APPLICATION_100',
      },
    });
    let from = 'APPLICATION_100';
    for (const hop of hops) {
      await prisma.statusChange.create({
        data: {
          relationId: relation.id,
          fromStatus: from,
          toStatus: hop.to,
          changedById: mentor.id,
          createdAt: new Date(start.getTime() + hop.dayOffset * DAY),
        },
      });
      from = hop.to;
    }
  };

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const before = await (await page.request.get('/api/admin/analytics/funnel')).json();

    // One journey all the way to the end, one that stops early.
    await makeJourney('done', [
      { to: 'APPROVAL_PENDING_220', dayOffset: 2 },
      { to: 'INTERVIEW_PENDING_250', dayOffset: 5 },
      { to: 'INTRODUCTION_PENDING_270', dayOffset: 7 },
      { to: 'INTERNSHIP_STARTING_300', dayOffset: 9 },
      { to: 'INTERNSHIP_IN_PROGRESS_450', dayOffset: 11 },
      { to: 'INTERNSHIP_COMPLETED_490', dayOffset: 15 },
      { to: 'JOB_SEEKING_500', dayOffset: 18 },
      { to: 'HIREABLE_600', dayOffset: 21 },
      { to: 'HIRED_660', dayOffset: 25 },
      { to: 'EMPLOYED_700', dayOffset: 30 },
    ]);
    await makeJourney('stalled', [{ to: 'APPROVAL_PENDING_220', dayOffset: 3 }]);

    const after = await (await page.request.get('/api/admin/analytics/funnel')).json();

    // The order is the ORG'S OWN on-path sequence, not a hardcoded list, and
    // the off-path stages are absent from it.
    expect(after.order[0]).toBe('APPLICATION_100');
    expect(after.order).not.toContain('INTERNSHIP_DROPPED_460');
    expect(after.order).not.toContain('INTERNSHIP_FOUND_ELSEWHERE_800');
    // Whatever the completion stage is called, it is the last one in that order.
    expect(after.timeToHire.completionKey).toBe(after.order[after.order.length - 1]);

    const enteredAt = (payload: { conversions: { key: string; entered: number }[] }, key: string) =>
      payload.conversions.find((c) => c.key === key)!.entered;

    // Both new journeys reached the first stage; one of them reached the last.
    expect(enteredAt(after, 'APPLICATION_100') - enteredAt(before, 'APPLICATION_100')).toBe(2);
    expect(after.timeToHire.considered - before.timeToHire.considered).toBe(2);
    expect(after.timeToHire.completed - before.timeToHire.completed).toBe(1);
    // The stalled journey is not counted as a fast hire.
    expect(after.timeToHire.completed).toBeLessThan(after.timeToHire.considered);
    // Every rate is either a real percentage or an explicit "no data".
    for (const c of after.conversions) {
      if (c.entered === 0 || c.terminal) expect(c.rate).toBeNull();
      else expect(typeof c.rate).toBe('number');
    }

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('funnel-kpi-card')).toBeVisible({ timeout: 20_000 });
    // The screen names the population behind the median rather than quoting a
    // bare number — the whole point of handling censoring out loud.
    await expect(page.getByTestId('tth-population')).toContainText(String(after.timeToHire.completed));
    await expect(page.getByTestId('tth-population')).toContainText(String(after.timeToHire.considered));
    await expect(page.getByTestId('conversion-APPLICATION_100')).toContainText('%');
  } finally {
    for (const e of menteeEmails) await cleanupByEmail(e);
    await cleanupByEmail(mentorEmail);
  }
});
