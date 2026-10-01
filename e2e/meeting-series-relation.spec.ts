import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// A standing 1:1 (#2013): a MeetingSeries on a mentorship relation, no project,
// with an interval and an end condition. Still a rule, never rows (#1110): both
// participants see it on their calendars, the mentee cannot change it, nobody
// else can see it, and cancelling it removes it everywhere.

const PW = 'StandingOneToOne1!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

async function seriesEvents(ctx: APIRequestContext, title: string) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10);
  const res = await ctx.get(`/api/calendar-events?from=${from}&to=${to}`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { events: { type: string; title: string; date: string; who: string }[] };
  return body.events.filter((e) => e.type === 'series' && e.title === title);
}

test('a standing biweekly 1:1 with an end: both participants see exactly its meetings, nobody else can, and cancel removes it', async () => {
  const mentorEmail = uniqueEmail('s11-mentor');
  const menteeEmail = uniqueEmail('s11-mentee');
  const otherEmail = uniqueEmail('s11-other');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Standing Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Standing Mentee');
  await seedUser(otherEmail, PW, 'MENTOR', 'Unrelated Mentor');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const title = `Standing 1:1 ${Date.now().toString(36)}`;

  const mentorCtx = await ctxFor(mentorEmail);
  const menteeCtx = await ctxFor(menteeEmail);
  const otherCtx = await ctxFor(otherEmail);
  let seriesId = '';
  try {
    // Exactly one context: both, or neither, is the shared 400.
    const base = { title, daysOfWeek: [1], timeOfDay: '10:00', timeZone: 'UTC' };
    expect((await mentorCtx.post('/api/meeting-series', { data: base })).status()).toBe(400);
    const project = await prisma.project.create({ data: { name: `S11 ${title}`, ownerType: 'MENTOR', ownerUserId: mentor.id } });
    expect(
      (await mentorCtx.post('/api/meeting-series', { data: { ...base, projectId: project.id, relationId: relation.id } })).status()
    ).toBe(400);
    await prisma.project.delete({ where: { id: project.id } });

    // Someone else's relation is a missing one.
    expect((await otherCtx.post('/api/meeting-series', { data: { ...base, relationId: relation.id } })).status()).toBe(404);

    // Every other Monday, three meetings, then it ends.
    const created = await mentorCtx.post('/api/meeting-series', {
      data: { ...base, relationId: relation.id, intervalWeeks: 2, maxOccurrences: 3 },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    seriesId = body.series.id;
    expect(body.series).toMatchObject({ relationId: relation.id, projectId: null, intervalWeeks: 2, maxOccurrences: 3 });
    expect(body.series.nextOccurrence).toBeTruthy();

    // Still a rule: no Meeting rows.
    expect(await prisma.meeting.count({ where: { seriesId } })).toBe(0);

    // Both participants see exactly the three meetings, two weeks apart, each
    // naming the other person.
    for (const [ctx, who] of [[mentorCtx, 'Standing Mentee'], [menteeCtx, 'Standing Mentor']] as const) {
      const events = await seriesEvents(ctx, title);
      expect(events).toHaveLength(3);
      const times = events.map((e) => new Date(e.date).getTime());
      expect(times[1] - times[0]).toBe(14 * DAY);
      expect(times[2] - times[1]).toBe(14 * DAY);
      for (const e of events) {
        expect(new Date(e.date).getUTCDay()).toBe(1);
        expect(e.date.slice(11, 16)).toBe('10:00');
        expect(e.who).toBe(who);
      }
    }

    // The mentee reads it but cannot change it; an unrelated mentor sees nothing.
    const menteeList = await menteeCtx.get(`/api/meeting-series?relationId=${relation.id}`);
    expect(menteeList.status()).toBe(200);
    expect((await menteeList.json()).series.map((s: { id: string }) => s.id)).toEqual([seriesId]);
    expect((await menteeCtx.put('/api/meeting-series', { data: { id: seriesId, title: 'hijacked' } })).ok()).toBe(false);
    expect((await menteeCtx.delete('/api/meeting-series', { data: { id: seriesId } })).ok()).toBe(false);
    expect((await otherCtx.get(`/api/meeting-series?relationId=${relation.id}`)).status()).toBe(404);
    expect((await otherCtx.put('/api/meeting-series', { data: { id: seriesId, title: 'hijacked' } })).status()).toBe(404);
    expect(await seriesEvents(otherCtx, title)).toHaveLength(0);

    // A standing 1:1 does not turn into a project call.
    const otherProject = await prisma.project.create({ data: { name: `S11b ${title}`, ownerType: 'MENTOR', ownerUserId: mentor.id } });
    expect((await mentorCtx.put('/api/meeting-series', { data: { id: seriesId, projectId: otherProject.id } })).status()).toBe(400);
    await prisma.project.delete({ where: { id: otherProject.id } });

    // Weekly and until-cancelled again: the calendar follows the rule.
    const edited = await mentorCtx.put('/api/meeting-series', { data: { id: seriesId, intervalWeeks: 1, maxOccurrences: null } });
    expect(edited.ok()).toBeTruthy();
    expect((await seriesEvents(mentorCtx, title)).length).toBeGreaterThanOrEqual(16);

    // Cancel: gone for both, with no residue.
    expect((await mentorCtx.delete('/api/meeting-series', { data: { id: seriesId } })).ok()).toBeTruthy();
    expect(await seriesEvents(mentorCtx, title)).toHaveLength(0);
    expect(await seriesEvents(menteeCtx, title)).toHaveLength(0);
    expect(await prisma.meeting.count({ where: { seriesId } })).toBe(0);
  } finally {
    await mentorCtx.dispose();
    await menteeCtx.dispose();
    await otherCtx.dispose();
    await prisma.meetingSeries.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of [mentorEmail, menteeEmail, otherEmail]) await cleanupByEmail(e);
  }
});
