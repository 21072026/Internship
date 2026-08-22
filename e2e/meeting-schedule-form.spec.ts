import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.use({ serviceWorkers: 'block' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #443 (B6/B9): the meeting form uses separate Date + Time fields (so entering
// a time doesn't pop a calendar) and preset topic suggestions. Scheduling with
// the split fields still creates the meeting.
test('mentor schedules a meeting via separate date and time fields', async ({ page }) => {
  const mentorEmail = uniqueEmail('mtg-mentor');
  const menteeEmail = uniqueEmail('mtg-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Mtg Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Mtg Mentee');
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'Pass1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/mentor/meetings');
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Title').fill('Weekly check-in');
    await page.getByLabel('Date', { exact: true }).fill('2026-08-01');
    await page.getByLabel('Time', { exact: true }).fill('14:30');
    await page.getByRole('button', { name: /send invite/i }).click();

    // Confirmation banner shows the meeting was created for 1 mentee.
    await expect(page.getByText(/invite sent to 1/i)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// #930 — an empty initial array is not a confirmed empty response. Hold the
// mentorship request open so the assertion covers the whole loading window,
// including the first client render.
test('meetings page does not flash empty states while mentorship data is loading', async ({ page }) => {
  const mentorEmail = uniqueEmail('mtg-loading-mentor');
  const menteeEmail = uniqueEmail('mtg-loading-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Loading Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Known Loading Mentee');
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });

  try {
    await signInAndSettle(page, mentorEmail, 'Pass1234!', '/mentor');

    let releaseRequest!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
    await page.route('**/api/mentorship', async (route) => {
      markRequestStarted();
      await release;
      await route.continue();
    });

    const navigation = page.goto('/mentor/meetings');
    await requestStarted;
    await expect(page.getByTestId('meetings-relations-loading')).toBeVisible();
    await expect(page.getByText('No mentees assigned')).toHaveCount(0);
    await expect(page.getByText('No meetings yet')).toHaveCount(0);
    await expect(page.getByText('Meetings (0)')).toHaveCount(0);

    releaseRequest();
    await navigation;
    await expect(page.getByText('Known Loading Mentee')).toBeVisible();
    await expect(page.getByText('No mentees assigned')).toHaveCount(0);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('meetings page shows the genuine empty state only after loading completes', async ({ page }) => {
  const mentorEmail = uniqueEmail('mtg-empty-mentor');
  await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Empty Mentor');

  try {
    await signInAndSettle(page, mentorEmail, 'Pass1234!', '/mentor');
    await page.goto('/mentor/meetings');
    await expect(page.getByText('No mentees assigned')).toBeVisible();
    await expect(page.getByText('No meetings yet')).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

test('meetings page shows an error instead of empty states when an API request fails', async ({ page }) => {
  const mentorEmail = uniqueEmail('mtg-error-mentor');
  await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Error Mentor');

  try {
    await signInAndSettle(page, mentorEmail, 'Pass1234!', '/mentor');
    await page.route('**/api/mentorship', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test"}' }));
    await page.goto('/mentor/meetings');

    await expect(page.getByTestId('meetings-load-error')).toBeVisible();
    await expect(page.getByText('Failed to load meetings. Please try again.')).toBeVisible();
    await expect(page.getByText('No mentees assigned')).toHaveCount(0);
    await expect(page.getByText('No meetings yet')).toHaveCount(0);
    await expect(page.getByText('Meetings (0)')).toHaveCount(0);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
