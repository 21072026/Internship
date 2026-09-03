import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * Mentor analytics gets the parity the admin screen has had since #420: a date
 * range, an export and a print layout (#1913).
 *
 * The seeded activity sits in 2019-03, a month no other spec touches, so the
 * window assertions are deterministic. The load-bearing part is the API: a
 * range must move the numbers that describe EVENTS (interactions, completed
 * goals, stage moves) and must NOT move the ones that describe current STATE
 * (the stage distribution, totals, outcomes) — reporting a smaller pipeline for
 * a narrower window is the specific misreading this split exists to prevent.
 */

const PASSWORD = 'MentorRange123!';

let mentorEmail: string;
let menteeEmail: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mentorEmail = uniqueEmail('mar-mentor');
  menteeEmail = uniqueEmail('mar-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'MAR Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'MAR Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      startDate: new Date('2019-03-01T00:00:00Z'),
    },
  });
  await prisma.interactionLog.create({
    data: { relationId: rel.id, date: new Date('2019-03-10T00:00:00Z'), notes: 'mar', type: 'Meeting' },
  });
  await prisma.goal.create({
    data: {
      relationId: rel.id,
      title: 'MAR goal',
      status: 'DONE',
      completedAt: new Date('2019-03-12T00:00:00Z'),
    },
  });
  await prisma.statusChange.create({
    data: {
      relationId: rel.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'APPROVAL_PENDING_220',
      changedById: mentor.id,
      createdAt: new Date('2019-03-10T00:00:00Z'),
    },
  });
});

test.afterAll(async () => {
  if (menteeEmail) await cleanupByEmail(menteeEmail);
  if (mentorEmail) await cleanupByEmail(mentorEmail);
  await prisma.$disconnect();
});

test('the range moves the event counts and leaves the distribution alone', async ({ page }) => {
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

  const covering = await (
    await page.request.get('/api/mentor/analytics?from=2019-01-01&to=2019-06-30')
  ).json();
  expect(covering.range).toEqual({ from: '2019-01-01', to: '2019-06-30' });
  expect(covering.interactions).toBeGreaterThanOrEqual(1);
  expect(covering.goals.doneInRange).toBeGreaterThanOrEqual(1);
  expect(covering.statusChanges).toBeGreaterThanOrEqual(1);
  // One row per mentee, carrying what the export writes.
  const row = (covering.rows as { menteeName: string; interactions: number; goalsDone: number }[]).find(
    (r) => r.menteeName === 'MAR Mentee'
  );
  expect(row?.interactions).toBeGreaterThanOrEqual(1);
  expect(row?.goalsDone).toBeGreaterThanOrEqual(1);

  const excluding = await (
    await page.request.get('/api/mentor/analytics?from=2020-01-01&to=2020-03-31')
  ).json();
  expect(excluding.interactions).toBe(0);
  expect(excluding.goals.doneInRange).toBe(0);
  expect(excluding.statusChanges).toBe(0);
  // …while the state-shaped numbers are identical in both windows.
  expect(excluding.totalRelations).toBe(covering.totalRelations);
  expect(excluding.funnel).toEqual(covering.funnel);
  expect(excluding.hired).toBe(covering.hired);
});

test('a malformed or inverted range falls back instead of failing', async ({ page }) => {
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

  const bad = await page.request.get('/api/mentor/analytics?from=not-a-date&to=also-bad');
  expect(bad.status()).toBe(200);
  const inverted = await page.request.get('/api/mentor/analytics?from=2030-01-01&to=2020-01-01');
  expect(inverted.status()).toBe(200);
  // The fallback window is reported, so the caller can see what it got.
  const body = await inverted.json();
  expect(body.range.from < body.range.to).toBeTruthy();
});

test('the screen offers the range, the export and print', async ({ page }) => {
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor/analytics');

  await expect(page.getByTestId('mentor-analytics-range')).toBeVisible();
  await expect(page.getByTestId('mentor-analytics-window')).toBeVisible();
  // Ungated on purpose: a mentor's own numbers are free core, so the export
  // button must never be behind an entitlement.
  await expect(page.getByTestId('mentor-analytics-export')).toBeEnabled();
  await expect(page.getByTestId('mentor-analytics-print')).toBeEnabled();

  await page.getByTestId('mentor-analytics-range').selectOption('30');
  // The window caption follows the preset, which proves the refetch happened.
  await expect(page.getByTestId('mentor-analytics-window')).not.toContainText('2019');
});
