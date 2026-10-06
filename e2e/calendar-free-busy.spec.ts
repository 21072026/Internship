import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { E2E_GOOGLE_MOCK_PORT } from '../playwright.config';

// Provider free/busy (#1997): a block that exists only in the mentor's real
// Google calendar refuses a booking, as bare busy time — never its title. A
// connection without the scope, or a provider that fails, falls back to
// today's database-only answer, and the failure is noted on the connection.

const MOCK = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const PW = 'FreeBusy123!';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function nextWeekWednesday(hourUtc: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() + (7 - sinceMonday + 2) * DAY + hourUtc * HOUR);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a block only in the real calendar refuses a booking; no scope or a failing provider degrades to the database', async ({ page, request }) => {
  test.slow();
  const mentorEmail = uniqueEmail('fb-mentor');
  const menteeEmail = uniqueEmail('fb-mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'FB Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'FB Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const busyStart = nextWeekWednesday(10);
  try {
    // The mentor connects Google, the way google-calendar.spec does it.
    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    const consent = await page.request.get('/api/integrations/google/connect', { maxRedirects: 0 });
    const state = new URL(consent.headers()['location']).searchParams.get('state')!;
    await page.request.get(`/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
    const conn = await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { userId: mentor.id } });
    expect(conn.scope).toContain('calendar.freebusy');

    // Wednesday 10:00–11:00 is taken in the real calendar — something this app never saw.
    await request.post(`${MOCK}/__freebusy`, { data: { busy: [{ start: busyStart.toISOString(), end: new Date(busyStart.getTime() + HOUR).toISOString() }] } });

    const book = (at: Date, title = 'One-to-one') =>
      page.request.post('/api/meetings', { data: { relationIds: [rel.id], title, scheduledAt: at.toISOString() } });
    const refused = await book(new Date(busyStart.getTime() + HOUR / 2));
    expect(refused.status()).toBe(409);
    // Busy, and nothing more: the provider's "summary" never crosses the boundary.
    expect(await refused.json()).toMatchObject({ code: 'conflict', conflictsWith: { title: '', startsAt: busyStart.toISOString() } });
    // Back to back with it is fine.
    expect((await book(new Date(busyStart.getTime() + HOUR), 'Right after')).ok()).toBeTruthy();

    // The mentee sees the hour as taken — on their request and on the picker.
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    const ask = await page.request.post('/api/meeting-requests', { data: { relationId: rel.id, topic: 'Career', proposedAt: busyStart.toISOString() } });
    expect(ask.status()).toBe(409);
    const avail = await (await page.request.get(`/api/availability?mentorId=${mentor.id}`)).json();
    expect(avail.busy).toContainEqual({ start: busyStart.toISOString(), end: new Date(busyStart.getTime() + HOUR).toISOString() });
    expect(JSON.stringify(avail)).not.toContain('Dentist');
    expect(JSON.stringify(await ask.json())).not.toContain('Dentist');

    // A connection granted before the scope existed: exactly today's behaviour.
    await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { scope: 'https://www.googleapis.com/auth/calendar.events openid email' } });
    const later = new Date(busyStart.getTime() + DAY);
    await request.post(`${MOCK}/__freebusy`, { data: { busy: [{ start: later.toISOString(), end: new Date(later.getTime() + HOUR).toISOString() }] } });
    await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
    expect((await book(later, 'Unscoped')).ok()).toBeTruthy();
    // …and the account card offers — does not force — a reconnect.
    const status = await (await page.request.get('/api/integrations/calendar/status')).json();
    expect(status.providers.find((p: { provider: string }) => p.provider === 'google')).toMatchObject({ connected: true, freeBusy: false });

    // A failing provider degrades to the database answer and says so on the connection.
    await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { scope: conn.scope, lastError: null } });
    await request.post(`${MOCK}/__freebusy`, { data: { fail: true } });
    const evenLater = new Date(busyStart.getTime() + 2 * DAY);
    // Read on a path that pushes nothing to Google afterwards — a successful
    // push would rightly overwrite `lastError` with "fine" again.
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    const degraded = await page.request.post('/api/meeting-requests', { data: { relationId: rel.id, topic: 'Provider down', proposedAt: evenLater.toISOString() } });
    expect(degraded.status()).toBe(201);
    expect((await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { id: conn.id } })).lastError).toContain('Free/busy unavailable');

    // Nothing from the provider was stored anywhere.
    expect(await prisma.meeting.count({ where: { relationId: rel.id, title: { contains: 'Dentist' } } })).toBe(0);
  } finally {
    await request.post(`${MOCK}/__freebusy`, { data: {} });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
    await prisma.googleCalendarEventLink.deleteMany({ where: { connection: { userId: mentor.id } } }).catch(() => {});
    await prisma.googleCalendarConnection.deleteMany({ where: { userId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
