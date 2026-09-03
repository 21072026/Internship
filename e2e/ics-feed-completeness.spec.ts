import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #2015 — the subscription feed carries everything the in-app calendar shows.
// Before this it served relation meetings only, so the weekly project call and
// the stage deadline a mentor sees in the app were silently missing from the
// calendar they actually live in.
//
// The second half of the test is the privacy invariant that widening puts at
// risk: whatever the event type, the feed may expose a title and a time and
// nothing else — no join link, no participant name.
const PASSWORD = 'IcsFeed123!';

const mentorEmail = uniqueEmail('ics-mentor');
const menteeEmail = uniqueEmail('ics-mentee');
const MENTEE_NAME = 'Zebra Secretname';
const MEETING_TITLE = 'Relation Sync IcsFeed';
const SERIES_TITLE = 'Weekly Project Call IcsFeed';
const JOIN_LINK = 'https://meet.jit.si/ics-feed-secret-room';

let projectId = '';
let seriesId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'ICS Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', MENTEE_NAME);

  const project = await prisma.project.create({
    data: {
      name: 'IcsFeed Project',
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: { create: [{ userId: mentor.id, role: 'OWNER' }] },
    },
  });
  projectId = project.id;

  // A stage deadline on the relation, plus a scheduled meeting with a join link.
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      projectId: project.id,
      stageDeadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: MEETING_TITLE,
      scheduledAt: new Date(Date.now() + 26 * 60 * 60 * 1000),
      meetLink: JOIN_LINK,
      rsvpToken: randomBytes(16).toString('hex'),
      createdById: mentor.id,
    },
  });

  // Every weekday, so an occurrence is guaranteed inside the feed's window.
  const series = await prisma.meetingSeries.create({
    data: {
      projectId: project.id,
      title: SERIES_TITLE,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: '09:00',
      timeZone: 'Europe/Istanbul',
      fixedLink: JOIN_LINK,
      createdById: mentor.id,
    },
  });
  seriesId = series.id;
});

test.afterAll(async () => {
  await prisma.meetingSeries.deleteMany({ where: { id: seriesId } });
  await cleanupByEmail(mentorEmail);
  await cleanupByEmail(menteeEmail);
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.$disconnect();
});

test('the subscription feed carries meetings, series occurrences and deadlines — and no PII', async ({ page, request }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', mentorEmail);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

  // A mentor can now obtain and rotate their own token from their own calendar
  // page — before #2015 the card was mounted on the mentee portal only.
  await page.goto('/mentor/calendar');
  await expect(page.getByTestId('ics-feed-card')).toBeVisible();

  const created = await page.request.post('/api/account/ics-feed');
  expect(created.status()).toBe(200);
  const { token } = await created.json();

  // Fetched WITHOUT a session, the way a calendar app does it.
  const feed = await request.get(`/api/calendar/feed/${token}`);
  expect(feed.status()).toBe(200);
  const body = await feed.text();

  expect(body).toContain('BEGIN:VEVENT');
  expect(body).toContain(MEETING_TITLE);
  // The recurring project call, expanded from its rule…
  expect(body).toContain(`UID:series-${seriesId}-`);
  expect(body).toContain(SERIES_TITLE);
  // …and the stage deadline, under its English stage label.
  expect(body).toContain('UID:deadline-');
  expect(body).toContain('100 · First contact');

  // Title and time only: no join link (from either the meeting or the series
  // rule), no participant name, no DESCRIPTION/LOCATION lines at all.
  expect(body).not.toContain(JOIN_LINK);
  expect(body).not.toContain('https://');
  expect(body).not.toContain(MENTEE_NAME);
  expect(body).not.toContain('DESCRIPTION');
  expect(body).not.toContain('LOCATION');
});
