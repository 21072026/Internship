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
    await expect(page.getByTestId('google-calendar-card')).toBeVisible({ timeout: 15_000 });
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
      data: { relationIds: [relation.id], title: 'GCal Sync Meeting', scheduledAt },
    });
    expect(created.ok()).toBeTruthy();

    await expect
      .poll(async () => prisma.googleCalendarEventLink.count({ where: { connectionId: conn!.id } }), { timeout: 15_000 })
      .toBe(1);

    const mockState = await (await request.get(`${MOCK}/__state`)).json();
    const titles = (mockState.events as { summary: string }[]).map((e) => e.summary);
    expect(titles).toContain('GCal Sync Meeting');

    // Disconnecting revokes at Google and forgets the tokens here.
    const removed = await page.request.delete('/api/integrations/google/connection');
    expect(removed.ok()).toBeTruthy();
    expect(await prisma.googleCalendarConnection.count({ where: { userId: mentor.id } })).toBe(0);

    const afterRevoke = await (await request.get(`${MOCK}/__state`)).json();
    expect((afterRevoke.revoked as string[]).length).toBeGreaterThan(0);
  } finally {
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
