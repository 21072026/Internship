import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #1548: GET /api/meetings used a bare `include`, so every column of the row —
// `rsvpToken` among them — reached whoever called it. That token is a bearer
// credential: /rsvp/<token> is public (the token IS the auth) and
// /api/calendar/<token> hands out the event, so a mentor or an admin holding it
// could answer the invitation as the mentee, with no session at all.
//
// The rule this spec pins: the token goes to the MENTEE the meeting belongs to
// (their portal card RSVPs and downloads the .ics with it) and to nobody else.

const PASSWORD = 'RsvpScope123!';

const adminEmail = uniqueEmail('rst-admin');
const mentorEmail = uniqueEmail('rst-mentor');
const menteeEmail = uniqueEmail('rst-mentee');
let adminId = '';
let mentorId = '';
let menteeId = '';
let relationId = '';
let meetingId = '';
let token = '';

const TITLE = 'RSVP Scope Meeting';

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page, email: string, landing: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

/** The meeting rows this caller can see, as raw JSON objects. */
async function fetchMeetings(page: import('@playwright/test').Page) {
  const res = await page.request.get('/api/meetings');
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.meetings ?? []) as Record<string, unknown>[];
}

test.beforeAll(async () => {
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'RST Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'RST Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'RST Mentee');
  adminId = admin.id;
  mentorId = mentor.id;
  menteeId = mentee.id;
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId } });
  relationId = rel.id;
  token = randomBytes(24).toString('hex');
  const meeting = await prisma.meeting.create({
    data: {
      relationId,
      title: TITLE,
      scheduledAt: new Date(Date.now() + 30 * 60 * 60 * 1000),
      meetLink: 'https://meet.jit.si/rst-scope',
      rsvpToken: token,
      createdById: mentorId,
    },
  });
  meetingId = meeting.id;
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [adminId, mentorId, menteeId] } } });
  await prisma.meeting.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await cleanupByEmail(menteeEmail);
  await cleanupByEmail(mentorEmail);
  await cleanupByEmail(adminEmail);
  await prisma.$disconnect();
});

// Tagged @smoke: this is the one assertion that proves the credential is
// withheld from someone who is not the mentee, and the PR gate runs only the
// smoke subset (CLAUDE.md). Untagged, the sole regression test for a token leak
// would run in neither this PR's gate nor the gate of the PR that reintroduces
// the leak — and `main` auto-deploys to production. The other two cases stay
// untagged to keep the set small: the admin case exercises the *same* single
// `role === 'MENTEE'` conditional in the handler's `select` (only the `where`
// clause differs between the two roles, and that is not what is under test),
// and the mentee case guards the opposite over-correction, which is a visible
// portal breakage the full 4x/day suite catches soon enough.
test('GET /api/meetings withholds the rsvpToken from the mentor (#1548)', { tag: '@smoke' }, async ({ page }) => {
  await signIn(page, mentorEmail, '/mentor');

  const meetings = await fetchMeetings(page);
  const own = meetings.find((m) => m.id === meetingId);
  // The mentor still sees the meeting itself — this is a field fix, not an
  // authorization change.
  expect(own).toBeDefined();
  expect(own!.title).toBe(TITLE);
  expect(own!.meetLink).toBe('https://meet.jit.si/rst-scope');
  expect(own!.relation).toMatchObject({ mentee: { id: menteeId } });

  // …but not the credential.
  expect(own).not.toHaveProperty('rsvpToken');
  // Not on any row, and not anywhere else in the payload either.
  expect(JSON.stringify(meetings)).not.toContain(token);
});

test('GET /api/meetings withholds the rsvpToken from an admin (#1548)', async ({ page }) => {
  await signIn(page, adminEmail, '/admin');

  const meetings = await fetchMeetings(page);
  const own = meetings.find((m) => m.id === meetingId);
  expect(own).toBeDefined();
  expect(own).not.toHaveProperty('rsvpToken');
  expect(JSON.stringify(meetings)).not.toContain(token);
});

test('GET /api/meetings still gives the mentee their own rsvpToken (#1548)', async ({ page }) => {
  await signIn(page, menteeEmail, '/portal');

  const meetings = await fetchMeetings(page);
  const own = meetings.find((m) => m.id === meetingId);
  expect(own).toBeDefined();
  // The portal card RSVPs and builds /api/calendar/<token> from this field, so
  // removing it outright would break the mentee's own screen.
  expect(own!.rsvpToken).toBe(token);
});
