import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Story #874: meetings become visible to mentees. #913 opens GET /api/meetings
// to MENTEE (fail-closed for unlisted roles, own relations only), #914 puts an
// "Upcoming meetings" card with in-app RSVP + .ics on the portal, #915 adds
// /portal/calendar and a personal, revocable ICS subscription feed.
const PASSWORD = 'MenteeMeet123!';

const mentorEmail = uniqueEmail('mm-mentor');
const menteeEmail = uniqueEmail('mm-mentee');
const otherMenteeEmail = uniqueEmail('mm-other');
let mentorId = '';
let menteeId = '';
let otherMenteeId = '';
let relationId = '';
let otherRelationId = '';
let ownMeetingId = '';
let ownToken = '';
const OWN_TITLE = 'Own Sync Meeting';
const OTHER_TITLE = 'Foreign Secret Meeting';

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page, email: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'MM Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'MM Mentee');
  const other = await seedUser(otherMenteeEmail, PASSWORD, 'MENTEE', 'MM Other');
  mentorId = mentor.id;
  menteeId = mentee.id;
  otherMenteeId = other.id;
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId } });
  const otherRel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId: otherMenteeId } });
  relationId = rel.id;
  otherRelationId = otherRel.id;

  const own = await prisma.meeting.create({
    data: {
      relationId,
      title: OWN_TITLE,
      scheduledAt: new Date(Date.now() + 26 * 60 * 60 * 1000),
      meetLink: 'https://meet.jit.si/mm-own',
      rsvpToken: randomBytes(16).toString('hex'),
      createdById: mentorId,
    },
  });
  ownMeetingId = own.id;
  ownToken = own.rsvpToken;
  await prisma.meeting.create({
    data: {
      relationId: otherRelationId,
      title: OTHER_TITLE,
      scheduledAt: new Date(Date.now() + 27 * 60 * 60 * 1000),
      rsvpToken: randomBytes(16).toString('hex'),
      createdById: mentorId,
    },
  });
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [mentorId, menteeId, otherMenteeId] } } });
  await prisma.meeting.deleteMany({ where: { relationId: { in: [relationId, otherRelationId] } } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relationId, otherRelationId] } } });
  await cleanupByEmail(otherMenteeEmail);
  await cleanupByEmail(menteeEmail);
  await cleanupByEmail(mentorEmail);
  await prisma.$disconnect();
});

test('GET /api/meetings serves the mentee their own meetings only; POST stays closed (#913)', async ({ page }) => {
  await signIn(page, menteeEmail, '/portal');

  const res = await page.request.get('/api/meetings');
  expect(res.status()).toBe(200);
  const { meetings } = await res.json();
  const titles = (meetings as { title: string }[]).map((m) => m.title);
  expect(titles).toContain(OWN_TITLE);
  // IDOR: another mentee's meeting must never appear, under any parameter.
  expect(titles).not.toContain(OTHER_TITLE);

  // A mentee REQUESTS meetings (MeetingRequest); scheduling stays closed.
  const post = await page.request.post('/api/meetings', {
    data: { relationIds: [relationId], title: 'Sneaky', scheduledAt: new Date().toISOString() },
  });
  expect([401, 403]).toContain(post.status());
});

test('portal card: mentee sees the meeting, RSVPs in-app, downloads the .ics (#914)', { tag: '@smoke' }, async ({ page }) => {
  await signIn(page, menteeEmail, '/portal');

  const card = page.getByTestId('upcoming-meetings-card');
  await expect(card).toBeVisible();
  await expect(card.getByText(OWN_TITLE)).toBeVisible();
  // The other mentee's meeting is not on this card either.
  await expect(card.getByText(OTHER_TITLE)).toHaveCount(0);

  // In-app RSVP: accept, badge flips, DB agrees.
  await card.getByTestId(`rsvp-yes-${ownMeetingId}`).click();
  await expect.poll(async () => (await prisma.meeting.findUniqueOrThrow({ where: { id: ownMeetingId } })).rsvp).toBe('ACCEPTED');

  // "Add to calendar" serves a valid single-meeting .ics.
  const ics = await page.request.get(`/api/calendar/${ownToken}`);
  expect(ics.status()).toBe(200);
  const body = await ics.text();
  expect(body).toContain('BEGIN:VCALENDAR');
  expect(body).toContain('Own Sync Meeting');
});

test('/portal/calendar renders the mentee calendar (#915)', async ({ page }) => {
  await signIn(page, menteeEmail, '/portal');
  await page.goto('/portal/calendar');
  await expect(page.getByTestId('portal-tab-calendar')).toBeVisible();
  // The shared CalendarView mounts (view switcher present)…
  await expect(page.getByTestId('calendar-view-month')).toBeVisible();
  // …and the agenda view lists the mentee's own meeting.
  await page.getByTestId('calendar-view-agenda').click();
  await expect(page.getByTestId(`calendar-event-meeting-${ownMeetingId}`)).toBeVisible();
});

test('personal ICS feed: own events only, minimal fields, rotate + revoke (#915)', async ({ page, request }) => {
  await signIn(page, menteeEmail, '/portal');

  // Create the token, fetch the feed WITHOUT a session (calendar apps have none).
  const created = await page.request.post('/api/account/ics-feed');
  expect(created.status()).toBe(200);
  const { token } = await created.json();
  expect(String(token).length).toBeGreaterThanOrEqual(32);

  const feed = await request.get(`/api/calendar/feed/${token}`);
  expect(feed.status()).toBe(200);
  const body = await feed.text();
  expect(body).toContain('Own Sync Meeting');
  // Not the other mentee's meeting, and no join links / PII beyond title+time.
  expect(body).not.toContain(OTHER_TITLE);
  expect(body).not.toContain('meet.jit.si');
  expect(body).not.toContain('MM Mentee');

  // Rotate: the old URL dies immediately, the new one serves.
  const rotated = await page.request.post('/api/account/ics-feed');
  const { token: token2 } = await rotated.json();
  expect(token2).not.toBe(token);
  expect((await request.get(`/api/calendar/feed/${token}`)).status()).toBe(404);
  expect((await request.get(`/api/calendar/feed/${token2}`)).status()).toBe(200);

  // Revoke: nothing serves any more.
  const revoked = await page.request.delete('/api/account/ics-feed');
  expect(revoked.status()).toBe(200);
  expect((await request.get(`/api/calendar/feed/${token2}`)).status()).toBe(404);
});
