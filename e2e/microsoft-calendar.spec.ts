import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { E2E_MICROSOFT_MOCK_PORT, E2E_GOOGLE_MOCK_PORT } from '../playwright.config';

/**
 * Microsoft 365 / Outlook as the second calendar provider (#1991).
 *
 * Microsoft's token endpoint and Graph are pointed at a local stub
 * (e2e/support/microsoft-mock.mjs), so the app's own half runs for real: the
 * signed state, the code exchange, the account e-mail from /me, sealing under
 * Microsoft's own purpose, mirroring a meeting with a LOCAL wall clock + zone
 * name, patching it on a move, withdrawing it on a cancel (through
 * cancelMeetingRows, the one cancel path), and forgetting the tokens on
 * disconnect. A person connected to Google AND Microsoft gets the meeting on
 * both, from one push.
 */

const MS = `http://127.0.0.1:${E2E_MICROSOFT_MOCK_PORT}`;
const GOOGLE = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const PASSWORD = 'MsCal123!';

type GraphEvent = { id: string; subject: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } };

async function graphEvents(request: APIRequestContext, subject: string): Promise<GraphEvent[]> {
  const state = await (await request.get(`${MS}/__state`)).json();
  return (state.events as GraphEvent[]).filter((e) => e.subject === subject);
}

/** Drive a provider's consent round trip the way the provider would. */
async function connect(page: Page, provider: 'microsoft' | 'google') {
  const consent = await page.request.get(`/api/integrations/${provider}/connect`, { maxRedirects: 0 });
  expect(consent.status()).toBe(307);
  const state = new URL(consent.headers()['location']).searchParams.get('state')!;
  const done = await page.request.get(`/api/integrations/${provider}/callback?code=ok&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
  expect(done.headers()['location']).toContain(`${provider}=connected`);
  return consent.headers()['location'];
}

/** The wall clock an instant shows in a zone, as Graph wants it. */
function wallClock(instant: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('connect, mirror, move, cancel and disconnect against the Graph stub', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('mscal-mentor');
  const menteeEmail = uniqueEmail('mscal-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'MsCal Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'MsCal Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const title = `MsCal Meeting ${Date.now()}`;

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    // The card offers Outlook next to Google, because both are switched on here.
    await page.goto('/account');
    await expect(page.getByTestId('microsoft-calendar-connect')).toBeVisible({ timeout: 15_000 });

    // A tampered state is refused and stores nothing.
    const consent = await page.request.get('/api/integrations/microsoft/connect', { maxRedirects: 0 });
    const consentUrl = new URL(consent.headers()['location']);
    expect(consentUrl.origin).toBe(MS);
    expect(consentUrl.searchParams.get('scope')).toBe('offline_access User.Read Calendars.ReadWrite');
    const state = consentUrl.searchParams.get('state')!;
    const tampered = await page.request.get(
      `/api/integrations/microsoft/callback?code=ok&state=${encodeURIComponent(state.slice(0, -3) + 'aaa')}`,
      { maxRedirects: 0 }
    );
    expect(tampered.headers()['location']).toContain('microsoft=failed');
    expect(await prisma.calendarConnection.count({ where: { userId: mentor.id } })).toBe(0);

    // A declined consent is "cancelled", not an error.
    const declined = await page.request.get(`/api/integrations/microsoft/callback?error=access_denied&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
    expect(declined.headers()['location']).toContain('microsoft=cancelled');

    await connect(page, 'microsoft');
    const conn = await prisma.calendarConnection.findUniqueOrThrow({ where: { userId_provider: { userId: mentor.id, provider: 'MICROSOFT' } } });
    // The account shown back is the UPN, since this account has no `mail`.
    expect(conn.accountEmail).toBe('connected.person@outlook.example');
    expect(conn.accessTokenEnc).not.toContain('ms-access-1');
    expect(conn.refreshTokenEnc).not.toContain('ms-refresh-1');
    await page.goto('/account');
    await expect(page.getByTestId('microsoft-calendar-connected')).toContainText('connected.person@outlook.example');

    // Google as well: one person, two connections, neither overwriting the other.
    await connect(page, 'google');
    expect(await prisma.calendarConnection.count({ where: { userId: mentor.id } })).toBe(2);

    // Schedule in Berlin: Graph gets Berlin's wall clock and the zone name.
    const at = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    at.setUTCHours(9, 0, 0, 0);
    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [relation.id], title, scheduledAt: at.toISOString(), timeZone: 'Europe/Berlin', durationMinutes: 45 },
    });
    expect(created.ok()).toBeTruthy();
    await expect.poll(async () => (await graphEvents(request, title)).length, { timeout: 15_000 }).toBe(1);
    const [event] = await graphEvents(request, title);
    expect(event.start).toEqual({ dateTime: wallClock(at, 'Europe/Berlin'), timeZone: 'Europe/Berlin' });
    expect(event.end).toEqual({ dateTime: wallClock(new Date(at.getTime() + 45 * 60_000), 'Europe/Berlin'), timeZone: 'Europe/Berlin' });
    // …and the same push reached Google.
    await expect
      .poll(async () => ((await (await request.get(`${GOOGLE}/__state`)).json()).events as { summary: string }[]).filter((e) => e.summary === title).length, { timeout: 15_000 })
      .toBe(1);

    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId: relation.id, title } });
    const link = await prisma.calendarEventLink.findUniqueOrThrow({ where: { meetingId_connectionId: { meetingId: meeting.id, connectionId: conn.id } } });
    expect(link.externalEventId).toBe(event.id);

    // A move PATCHes the same Graph event: one event, the new wall clock.
    const movedTo = new Date(at.getTime() + 2 * 24 * 3600 * 1000);
    // The zone the new time was picked on travels with the move, as the UI sends
    // it; without one the PATCH falls back to the mover's saved zone.
    const moved = await page.request.patch(`/api/meetings/${meeting.id}`, { data: { scheduledAt: movedTo.toISOString(), timeZone: 'Europe/Berlin' } });
    expect(moved.ok()).toBeTruthy();
    await expect
      .poll(async () => (await graphEvents(request, title)).map((e) => e.start.dateTime), { timeout: 15_000 })
      .toEqual([wallClock(movedTo, 'Europe/Berlin')]);
    expect((await graphEvents(request, title))[0].id).toBe(link.externalEventId);

    // Cancelling withdraws it from Outlook (and Google) — the Meeting row stays.
    const cancelled = await page.request.patch(`/api/meetings/${meeting.id}`, { data: { status: 'CANCELLED', cancelReason: 'Moved online' } });
    expect(cancelled.ok()).toBeTruthy();
    await expect.poll(async () => (await graphEvents(request, title)).length, { timeout: 15_000 }).toBe(0);
    expect(await prisma.calendarEventLink.count({ where: { meetingId: meeting.id } })).toBe(0);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe('CANCELLED');

    // Disconnect forgets the Microsoft tokens and leaves Google alone.
    const removed = await page.request.delete('/api/integrations/microsoft/connection');
    expect(removed.ok()).toBeTruthy();
    expect(await prisma.calendarConnection.count({ where: { userId: mentor.id, provider: 'MICROSOFT' } })).toBe(0);
    expect(await prisma.calendarConnection.count({ where: { userId: mentor.id, provider: 'GOOGLE' } })).toBe(1);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a Graph outage never fails scheduling; the error lands on the connection', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('mscal-down');
  const menteeEmail = uniqueEmail('mscal-down-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'MsCal Down');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'MsCal Down Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await connect(page, 'microsoft');
    await request.post(`${MS}/__fail`, { data: { fail: true } });
    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [relation.id], title: 'MsCal outage', scheduledAt: new Date(Date.now() + 9 * 24 * 3600 * 1000).toISOString() },
    });
    // The meeting is the product; the mirror is a convenience.
    expect(created.ok()).toBeTruthy();
    await expect
      .poll(async () => (await prisma.calendarConnection.findUniqueOrThrow({ where: { userId_provider: { userId: mentor.id, provider: 'MICROSOFT' } } })).lastError, { timeout: 15_000 })
      .toContain('Calendar write failed (503)');
    expect(await prisma.calendarEventLink.count({ where: { connection: { userId: mentor.id } } })).toBe(0);
  } finally {
    await request.post(`${MS}/__fail`, { data: { fail: false } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
