import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { E2E_GOOGLE_MOCK_PORT, E2E_MICROSOFT_MOCK_PORT } from '../playwright.config';

/**
 * A generated Google Meet room (#2009). Under the org policy GENERATE_PROVIDER,
 * an organiser with a connected Google Calendar gets a real Meet room from the
 * event created on their own calendar — and that room is the meeting's ONE
 * link: the mirror push adopts the same event instead of making a second. A
 * provider failure degrades to the built-in room and records the reason; an
 * organiser with no connected calendar is unaffected. Google is the local stub
 * (e2e/support/google-mock.mjs).
 */

const MOCK = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const MS = `http://127.0.0.1:${E2E_MICROSOFT_MOCK_PORT}`;
const PASSWORD = 'MeetRoom123!';

async function connect(page: Page, provider: 'google' | 'microsoft') {
  const consent = await page.request.get(`/api/integrations/${provider}/connect`, { maxRedirects: 0 });
  const state = new URL(consent.headers()['location']).searchParams.get('state')!;
  const ok = await page.request.get(`/api/integrations/${provider}/callback?code=ok&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
  expect(ok.headers()['location']).toContain(`${provider}=connected`);
}

test.describe('generated conferencing links', () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const mentorEmail = uniqueEmail('meet-mentor');
  const soloEmail = uniqueEmail('meet-solo-mentor');
  const menteeEmail = uniqueEmail('meet-mentee');
  const teamsEmail = uniqueEmail('teams-mentor');
  let teamsRelationId = '';
  let teamsMentorId = '';
  let orgId = '';
  let relationId = '';
  let soloRelationId = '';
  let mentorId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({
      data: { name: `Meet Org ${stamp}`, slug: `meet-${stamp}`, vertical: 'INTERNSHIP', conferencingPolicy: 'GENERATE_PROVIDER' },
    })).id;
    mentorId = (await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Meet Mentor', orgId)).id;
    const soloId = (await seedUser(soloEmail, PASSWORD, 'MENTOR', 'Meet Solo Mentor', orgId)).id;
    const menteeId = (await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Meet Mentee', orgId)).id;
    relationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId, status: 'ACTIVE' } })).id;
    // A second, already-completed pair so the unconnected mentor has a relation too.
    soloRelationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: soloId, menteeId, status: 'COMPLETED' } })).id;
    teamsMentorId = (await seedUser(teamsEmail, PASSWORD, 'MENTOR', 'Teams Mentor', orgId)).id;
    teamsRelationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: teamsMentorId, menteeId, status: 'COMPLETED' } })).id;
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${MOCK}/__conference`, { data: { fail: false } });
    await prisma.meeting.deleteMany({ where: { relationId: { in: [relationId, soloRelationId, teamsRelationId] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [mentorEmail, soloEmail, menteeEmail, teamsEmail]) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  test('a connected organiser gets one real Meet link; a failure falls back and says why', async ({ page, request }) => {
    test.setTimeout(120_000);
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await connect(page, 'google');
    const conn = await prisma.calendarConnection.findUniqueOrThrow({ where: { userId_provider: { userId: mentorId, provider: 'GOOGLE' } } });

    const scheduledAt = new Date(Date.now() + 4 * 24 * 3600_000).toISOString();
    const created = await page.request.post('/api/meetings', { data: { relationIds: [relationId], title: `Meet Room ${stamp}`, scheduledAt } });
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId, title: `Meet Room ${stamp}` } });
    expect(meeting.meetLink).toMatch(/^https:\/\/meet\.google\.com\/mock-\d+$/);

    // ONE event on the organiser's calendar: the generated one is the mirror
    // (PATCHed by the push), never a second event next to it.
    const link = await prisma.calendarEventLink.findFirstOrThrow({ where: { meetingId: meeting.id, connectionId: conn.id } });
    type MockEvent = { id: string; summary: string; hangoutLink?: string; location?: string };
    const named = async () =>
      ((await (await request.get(`${MOCK}/__state`)).json()).events as MockEvent[]).filter((e) => e.summary === `Meet Room ${stamp}`);
    await expect.poll(async () => (await named()).map((e) => e.location), { timeout: 15_000 }).toEqual([meeting.meetLink]);
    expect((await named())[0]).toMatchObject({ id: link.externalEventId, hangoutLink: meeting.meetLink });

    // Google failing: the meeting still gets a working room, and the reason is on the connection.
    await request.post(`${MOCK}/__conference`, { data: { fail: true } });
    const fallback = await page.request.post('/api/meetings', {
      data: { relationIds: [relationId], title: `Meet Fallback ${stamp}`, scheduledAt: new Date(Date.now() + 5 * 24 * 3600_000).toISOString() },
    });
    expect(fallback.ok()).toBeTruthy();
    const fell = await prisma.meeting.findFirstOrThrow({ where: { relationId, title: `Meet Fallback ${stamp}` } });
    expect(fell.meetLink).toBeTruthy();
    expect(fell.meetLink).not.toContain('meet.google.com');
    const after = await prisma.calendarConnection.findUniqueOrThrow({ where: { userId_provider: { userId: mentorId, provider: 'GOOGLE' } } });
    expect(after.lastError ?? '').toContain('Meeting room generation failed');
  });

  test('an organiser with no connected calendar gets the built-in room, never an error', async ({ page }) => {
    await signInAndSettle(page, soloEmail, PASSWORD, '/mentor');
    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [soloRelationId], title: `Meet Solo ${stamp}`, scheduledAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString() },
    });
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId: soloRelationId, title: `Meet Solo ${stamp}` } });
    expect(meeting.meetLink).toBeTruthy();
    expect(meeting.meetLink).not.toContain('meet.google.com');
  });

  test('an organiser on Microsoft 365 gets one Teams join link', async ({ page, request }) => {
    test.setTimeout(120_000);
    await signInAndSettle(page, teamsEmail, PASSWORD, '/mentor');
    await connect(page, 'microsoft');
    const title = `Teams Room ${stamp}`;
    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [teamsRelationId], title, scheduledAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() },
    });
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId: teamsRelationId, title } });
    expect(meeting.meetLink).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/mock-\d+$/);
    // One event in the organiser's Outlook: the Teams one, adopted as the mirror.
    type GraphEvent = { id: string; subject: string; isOnlineMeeting?: boolean };
    const named = async () => ((await (await request.get(`${MS}/__state`)).json()).events as GraphEvent[]).filter((e) => e.subject === title);
    await expect.poll(async () => (await named()).length, { timeout: 15_000 }).toBe(1);
    expect((await named())[0].isOnlineMeeting).toBe(true);
  });
});
