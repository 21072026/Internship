import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { E2E_GOOGLE_MOCK_PORT } from '../playwright.config';

/**
 * A recurring project meeting on its members' Google Calendars (#2654).
 *
 * A MeetingSeries has no Meeting row per occurrence (#1110), so the one-off
 * mirror had nothing to push. It is now ONE recurring event (an RRULE) per
 * connected member, keyed by GoogleCalendarEventLink.seriesId: created with the
 * series, PATCHed (same Google id) when it moves, withdrawn when it is deleted
 * or a member leaves. Against the stub in e2e/support/google-mock.mjs.
 */

const MOCK = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const PASSWORD = 'GcalSeries123!';

type MockEvent = { id: string; summary: string; recurrence?: string[]; start?: { dateTime?: string; timeZone?: string } };

test.beforeEach(() => {
  test.skip(!!process.env.BASE_URL, 'the Google stub only runs under the local webServer');
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function connectCalendar(ctx: APIRequestContext) {
  const consent = await ctx.get('/api/integrations/google/connect', { maxRedirects: 0 });
  const state = new URL(consent.headers()['location']).searchParams.get('state')!;
  const ok = await ctx.get(`/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
  expect(ok.headers()['location']).toContain('google=connected');
}

test('a series is ONE recurring event per connected member: created, moved in place, withdrawn', async ({ request }) => {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const title = `GCal Series ${stamp}`;
  const eventsNamed = async (summary: string): Promise<MockEvent[]> =>
    ((await (await request.get(`${MOCK}/__state`)).json()).events as MockEvent[]).filter((e) => e.summary.startsWith(summary));

  const org = await prisma.organization.create({ data: { name: `GCal Series ${stamp}`, slug: `gcal-series-${stamp}` } });
  const adminEmail = uniqueEmail('gcal-series-admin');
  const mentorEmail = uniqueEmail('gcal-series-mentor');
  const menteeEmail = uniqueEmail('gcal-series-mentee');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Series Admin', org.id);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Series Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Series Mentee', org.id);
  const project = await prisma.project.create({
    data: { name: `GCal Series Project ${stamp}`, ownerType: 'ADMIN', ownerUserId: admin.id, orgId: org.id },
  });
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: mentor.id, role: 'MENTOR' },
      // Never connects: must get nothing, and must not break anyone else's push.
      { projectId: project.id, userId: mentee.id, role: 'MENTEE' },
    ],
  });

  const mentorCtx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  let seriesId: string | undefined;
  try {
    expect((await signInViaApi(mentorCtx, mentorEmail, PASSWORD)).ok).toBe(true);
    await connectCalendar(mentorCtx);
    const conn = await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { userId: mentor.id } });

    expect((await signInViaApi(request, adminEmail, PASSWORD)).ok).toBe(true);
    const created = await request.post('/api/meeting-series', {
      data: { projectId: project.id, title, daysOfWeek: [1, 4], timeOfDay: '09:30', timeZone: 'Europe/Berlin', durationMinutes: 30 },
    });
    expect(created.status()).toBe(201);
    seriesId = (await created.json()).series.id as string;

    // One recurring event with the rule and the series' own clock.
    await expect.poll(async () => (await eventsNamed(title)).length, { timeout: 15_000 }).toBe(1);
    const [event] = await eventsNamed(title);
    expect(event.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,TH']);
    expect(event.start?.timeZone).toBe('Europe/Berlin');
    const link = await prisma.googleCalendarEventLink.findUniqueOrThrow({
      where: { seriesId_connectionId: { seriesId, connectionId: conn.id } },
    });
    expect(link.googleEventId).toBe(event.id);
    expect(link.meetingId).toBeNull();
    // Only the connected member has an event; nobody got one per occurrence.
    expect(await prisma.googleCalendarEventLink.count({ where: { seriesId } })).toBe(1);
    // Occurrences are never materialised to make this work (#1110).
    expect(await prisma.meeting.count({ where: { seriesId } })).toBe(0);

    // Moving it PATCHes the same event: same id, new rule, still one event.
    const moved = await request.put('/api/meeting-series', { data: { id: seriesId, daysOfWeek: [2], timeOfDay: '10:00', title: `${title} moved` } });
    expect(moved.ok()).toBeTruthy();
    await expect
      .poll(async () => (await eventsNamed(title)).map((e) => [e.id, e.summary, e.recurrence?.[0]]), { timeout: 15_000 })
      .toEqual([[event.id, `${title} moved`, 'RRULE:FREQ=WEEKLY;BYDAY=TU']]);

    // A member who leaves the project loses the event on the next sync.
    await prisma.projectMember.deleteMany({ where: { projectId: project.id, userId: mentor.id } });
    expect((await request.put('/api/meeting-series', { data: { id: seriesId, title: `${title} renamed` } })).ok()).toBeTruthy();
    await expect.poll(async () => (await eventsNamed(title)).length, { timeout: 15_000 }).toBe(0);
    expect(await prisma.googleCalendarEventLink.count({ where: { seriesId } })).toBe(0);

    // Back on the team, then the series is deleted: withdrawn before the DELETE answers.
    await prisma.projectMember.create({ data: { projectId: project.id, userId: mentor.id, role: 'MENTOR' } });
    expect((await request.put('/api/meeting-series', { data: { id: seriesId, title: `${title} again` } })).ok()).toBeTruthy();
    await expect.poll(async () => (await eventsNamed(title)).length, { timeout: 15_000 }).toBe(1);
    const deleted = await request.delete('/api/meeting-series', { data: { id: seriesId } });
    expect(deleted.ok()).toBeTruthy();
    expect(await eventsNamed(title)).toHaveLength(0);
    expect(await prisma.googleCalendarEventLink.count({ where: { seriesId } })).toBe(0);
  } finally {
    await mentorCtx.dispose();
    await prisma.googleCalendarEventLink.deleteMany({ where: { seriesId } }).catch(() => {});
    await prisma.meetingSeries.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    for (const e of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('a standing 1:1 is on both of its people’s calendars with its interval, and leaves them when the pairing ends', async ({ request }) => {
  // #2013: the audience of a relation series is the relation's mentor and
  // mentee — not project members, which a 1:1 has none of.
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const title = `GCal 1:1 ${stamp}`;
  const eventsNamed = async (summary: string): Promise<MockEvent[]> =>
    ((await (await request.get(`${MOCK}/__state`)).json()).events as MockEvent[]).filter((e) => e.summary.startsWith(summary));

  const org = await prisma.organization.create({ data: { name: `GCal 1:1 ${stamp}`, slug: `gcal-121-${stamp}` } });
  const mentorEmail = uniqueEmail('gcal-121-mentor');
  const menteeEmail = uniqueEmail('gcal-121-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'OneToOne Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OneToOne Mentee', org.id);
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id } });

  const menteeCtx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  let seriesId: string | undefined;
  try {
    expect((await signInViaApi(menteeCtx, menteeEmail, PASSWORD)).ok).toBe(true);
    await connectCalendar(menteeCtx);
    expect((await signInViaApi(request, mentorEmail, PASSWORD)).ok).toBe(true);
    await connectCalendar(request);

    const created = await request.post('/api/meeting-series', {
      data: { relationId: relation.id, title, daysOfWeek: [3], timeOfDay: '16:00', timeZone: 'Europe/Berlin', intervalWeeks: 2 },
    });
    expect(created.status()).toBe(201);
    seriesId = (await created.json()).series.id as string;

    await expect.poll(async () => (await eventsNamed(title)).length, { timeout: 15_000 }).toBe(2);
    for (const e of await eventsNamed(title)) expect(e.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE']);
    expect(await prisma.googleCalendarEventLink.count({ where: { seriesId } })).toBe(2);

    // The pairing completes: the next sync withdraws it from both calendars.
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { status: 'COMPLETED' } });
    expect((await request.put('/api/meeting-series', { data: { id: seriesId, title: `${title} renamed` } })).ok()).toBeTruthy();
    await expect.poll(async () => (await eventsNamed(title)).length, { timeout: 15_000 }).toBe(0);
    expect(await prisma.googleCalendarEventLink.count({ where: { seriesId } })).toBe(0);
  } finally {
    await menteeCtx.dispose();
    await prisma.googleCalendarEventLink.deleteMany({ where: { seriesId } }).catch(() => {});
    await prisma.meetingSeries.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of [mentorEmail, menteeEmail]) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
