import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { E2E_GOOGLE_MOCK_PORT } from '../playwright.config';

/**
 * User-consented Google Calendar integration (#709).
 *
 * Google's endpoints are pointed at a local stub (see e2e/support/google-mock.mjs
 * and the webServer env in playwright.config.ts), so the app's own half of the
 * flow is exercised for real: the signed state, the code exchange, sealing the
 * tokens, mirroring a meeting, and revoking on disconnect.
 */

const MOCK = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const PASSWORD = 'GoogleCal123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor connects their calendar, a meeting is mirrored, and disconnecting revokes it', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('gcal-mentor');
  const menteeEmail = uniqueEmail('gcal-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'GCal Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'GCal Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    // The card is offered because the integration is switched on in this run.
    await page.goto('/account');
    await expect(page.getByTestId('connected-calendars-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('google-calendar-connect')).toBeVisible();

    // Connect: the app redirects to the consent screen. We do not have Google's,
    // so read the state it minted out of the redirect and hand it back the way
    // Google would.
    const consent = await page.request.get('/api/integrations/google/connect', { maxRedirects: 0 });
    expect(consent.status()).toBe(307);
    const consentUrl = new URL(consent.headers()['location']);
    expect(consentUrl.host).toBe('accounts.google.com');
    const state = consentUrl.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // A tampered state must be refused — it is the only thing standing between
    // this callback and someone else's account being attached to this session.
    const tampered = await page.request.get(
      `/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state.slice(0, -3) + 'aaa')}`,
      { maxRedirects: 0 }
    );
    expect(tampered.headers()['location']).toContain('google=failed');
    expect(await prisma.googleCalendarConnection.count({ where: { userId: mentor.id } })).toBe(0);

    // The real callback stores the connection.
    const ok = await page.request.get(
      `/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 }
    );
    expect(ok.headers()['location']).toContain('google=connected');

    const conn = await prisma.googleCalendarConnection.findUnique({ where: { userId: mentor.id } });
    expect(conn).toBeTruthy();
    expect(conn!.googleEmail).toBe('connected.person@gmail.example');
    // The tokens are sealed at rest: the plaintext Google handed us must not be
    // findable in the row.
    expect(conn!.accessTokenEnc).not.toContain('mock-access-1');
    expect(conn!.refreshTokenEnc).not.toContain('mock-refresh-1');
    expect(conn!.accessTokenEnc.startsWith('v1.')).toBe(true);

    // The account page now shows which calendar is connected.
    await page.goto('/account');
    await expect(page.getByTestId('google-calendar-connected')).toContainText('connected.person@gmail.example');

    // Scheduling a meeting mirrors it onto that calendar.
    const scheduledAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const created = await page.request.post('/api/meetings', {
      // A 45-minute meeting (#1984): the mirrored event must end 45 minutes in,
      // not after the hour the sync used to assume.
      data: { relationIds: [relation.id], title: 'GCal Sync Meeting', scheduledAt, durationMinutes: 45 },
    });
    expect(created.ok()).toBeTruthy();

    await expect
      .poll(async () => prisma.googleCalendarEventLink.count({ where: { connectionId: conn!.id } }), { timeout: 15_000 })
      .toBe(1);

    const mockState = await (await request.get(`${MOCK}/__state`)).json();
    const titles = (mockState.events as { summary: string }[]).map((e) => e.summary);
    expect(titles).toContain('GCal Sync Meeting');
    type TimedEvent = { summary: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
    const mirrored = (mockState.events as TimedEvent[]).find((e) => e.summary === 'GCal Sync Meeting')!;
    expect(Date.parse(mirrored.end!.dateTime!) - Date.parse(mirrored.start!.dateTime!)).toBe(45 * 60_000);

    // ── #1986: the rest of the loop ──────────────────────────────────────────
    type MockEvent = { id: string; summary: string; start?: { dateTime?: string } };
    const eventsNamed = async (summary: string): Promise<MockEvent[]> =>
      ((await (await request.get(`${MOCK}/__state`)).json()).events as MockEvent[]).filter((e) => e.summary === summary);
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId: relation.id, title: 'GCal Sync Meeting' } });
    const link = await prisma.googleCalendarEventLink.findFirstOrThrow({ where: { meetingId: meeting.id } });

    // Rescheduling PATCHes the event it already made — the same Google id, one
    // event, the new time — instead of creating a second one.
    const movedTo = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    movedTo.setUTCSeconds(0, 0);
    const moved = await page.request.patch(`/api/meetings/${meeting.id}`, { data: { scheduledAt: movedTo.toISOString() } });
    expect(moved.ok()).toBeTruthy();
    await expect
      .poll(async () => (await eventsNamed('GCal Sync Meeting')).map((e) => e.start?.dateTime), { timeout: 15_000 })
      .toEqual([movedTo.toISOString()]);
    expect((await eventsNamed('GCal Sync Meeting'))[0].id).toBe(link.googleEventId);

    // Accepting a meeting request mirrors the meeting too — it used to be the
    // one scheduling path that never reached a calendar.
    const topic = `GCal Accepted Request ${Date.now()}`;
    const req = await prisma.meetingRequest.create({
      data: {
        relationId: relation.id,
        requestedById: mentee.id,
        topic,
        proposedAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    const accepted = await page.request.patch(`/api/meeting-requests/${req.id}`, { data: { action: 'accept' } });
    expect(accepted.ok()).toBeTruthy();
    await expect.poll(async () => (await eventsNamed(topic)).length, { timeout: 15_000 }).toBe(1);

    // Deleting a meeting takes it off the calendar, and our link row with it.
    const deleted = await page.request.delete(`/api/meetings/${meeting.id}`);
    expect(deleted.ok()).toBeTruthy();
    expect(await eventsNamed('GCal Sync Meeting')).toHaveLength(0);
    expect(await prisma.googleCalendarEventLink.count({ where: { googleEventId: link.googleEventId } })).toBe(0);

    // Disconnecting revokes at Google and forgets the tokens here.
    const removed = await page.request.delete('/api/integrations/google/connection');
    expect(removed.ok()).toBeTruthy();
    expect(await prisma.googleCalendarConnection.count({ where: { userId: mentor.id } })).toBe(0);

    const afterRevoke = await (await request.get(`${MOCK}/__state`)).json();
    expect((afterRevoke.revoked as string[]).length).toBeGreaterThan(0);
  } finally {
    await prisma.meetingRequest.deleteMany({ where: { relationId: relation.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a mentee who never connected is unaffected', async ({ page }) => {
  const mentorEmail = uniqueEmail('gcal-solo-mentor');
  const menteeEmail = uniqueEmail('gcal-solo-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'GCal Solo Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'GCal Solo Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    const created = await page.request.post('/api/meetings', {
      data: {
        relationIds: [relation.id],
        title: 'Unconnected Meeting',
        scheduledAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      },
    });
    // The whole point of the flag and the opt-in: scheduling works exactly as
    // before, and nothing is written anywhere on anyone's behalf.
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirst({ where: { relationId: relation.id } });
    expect(meeting).toBeTruthy();
    expect(await prisma.googleCalendarEventLink.count({ where: { meetingId: meeting!.id } })).toBe(0);
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
