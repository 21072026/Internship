import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import crypto from 'crypto';

// A recurring project meeting is a rule, not a pile of rows (#1110). These tests
// pin the three things that used to go wrong: creating one wrote weeks of
// `Meeting` rows, cancelling one left every row behind on the calendar, and the
// calendar rendered one entry per mentee instead of one meeting.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a recurring project meeting is a rule: no rows, one calendar entry, gone when cancelled', async ({ page }) => {
  const mentorEmail = uniqueEmail('ms-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Series Mentor');
  const menteeA = await seedUser(uniqueEmail('ms-mentee-a'), 'x', 'MENTEE', 'Series Mentee A');
  const menteeB = await seedUser(uniqueEmail('ms-mentee-b'), 'x', 'MENTEE', 'Series Mentee B');

  const project = await prisma.project.create({
    data: {
      name: `Series Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: menteeA.id, role: 'MENTEE' },
          { userId: menteeB.id, role: 'MENTEE' },
        ],
      },
    },
  });

  const relations = await Promise.all(
    [menteeA, menteeB].map((m) =>
      prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m.id, projectId: project.id } })
    )
  );

  // Tomorrow, so the occurrence is unambiguously in the future.
  const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const targetDow = target.getUTCDay();
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  let seriesId = '';
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const createRes = await page.request.post('/api/meeting-series', {
      // An explicit zone keeps the expected instant deterministic wherever the
      // suite runs; the browser sends its own zone in the real UI.
      data: {
        projectId: project.id,
        title: 'Weekly project sync',
        daysOfWeek: [targetDow],
        timeOfDay: '12:00',
        timeZone: 'UTC',
        meetLink: '',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    seriesId = created.series.id as string;
    expect(seriesId).toBeTruthy();
    // The rule resolves to a real instant, on the clock it was saved on.
    expect(created.series.nextOccurrence).toBe(
      new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12, 0)).toISOString()
    );

    // Nothing was materialised — that is the whole point.
    expect(await prisma.meeting.count({ where: { seriesId } })).toBe(0);

    // The calendar shows ONE entry for the team's weekly call, carrying the
    // meeting's own title — not one entry per mentee under their names.
    const dayQuery = `from=${encodeURIComponent(dayStart.toISOString())}&to=${encodeURIComponent(dayEnd.toISOString())}`;
    const calRes = await page.request.get(`/api/calendar-events?${dayQuery}`);
    expect(calRes.ok()).toBeTruthy();
    const seriesEvents = ((await calRes.json()).events as { type: string; title: string; date: string }[]).filter(
      (e) => e.type === 'series'
    );
    expect(seriesEvents).toHaveLength(1);
    expect(seriesEvents[0].title).toBe('Weekly project sync');
    expect(seriesEvents[0].date).toBe(
      new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12, 0)).toISOString()
    );

    // Moving it moves the entry — the old slot keeps nothing.
    const moveRes = await page.request.put('/api/meeting-series', { data: { id: seriesId, timeOfDay: '15:30' } });
    expect(moveRes.ok()).toBeTruthy();
    const movedEvents = ((await (await page.request.get(`/api/calendar-events?${dayQuery}`)).json()).events as {
      type: string;
      date: string;
    }[]).filter((e) => e.type === 'series');
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0].date).toBe(
      new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 15, 30)).toISOString()
    );

    // A row left by the pre-#1110 generator: cancelling has to take it with it,
    // otherwise it haunts the calendar forever — the bug this replaces.
    await prisma.meeting.create({
      data: {
        relationId: relations[0].id,
        title: 'Weekly project sync',
        scheduledAt: new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12, 0)),
        rsvpToken: crypto.randomBytes(24).toString('hex'),
        createdById: mentor.id,
        seriesId,
      },
    });
    // A legacy row is never rendered either — the rule is the only source.
    const withLegacy = ((await (await page.request.get(`/api/calendar-events?${dayQuery}`)).json()).events as {
      type: string;
    }[]).filter((e) => e.type === 'meeting');
    expect(withLegacy).toHaveLength(0);

    const cancelRes = await page.request.delete('/api/meeting-series', { data: { id: seriesId } });
    expect(cancelRes.ok()).toBeTruthy();
    expect((await cancelRes.json()).removedMeetings).toBe(1);
    expect(await prisma.meeting.count({ where: { seriesId } })).toBe(0);

    const afterCancel = (await (await page.request.get(`/api/calendar-events?${dayQuery}`)).json()).events as {
      type: string;
    }[];
    expect(afterCancel.filter((e) => e.type === 'series')).toHaveLength(0);
    expect(afterCancel.filter((e) => e.type === 'meeting')).toHaveLength(0);

    // A cancelled series stays cancelled and still produces nothing.
    const reviveRes = await page.request.put('/api/meeting-series', {
      data: { id: seriesId, title: 'Weekly project sync (cancelled)' },
    });
    expect(reviveRes.ok()).toBeTruthy();
    expect((await reviveRes.json()).series?.active).toBe(false);
  } finally {
    if (seriesId) await prisma.meetingSeriesReminder.deleteMany({ where: { seriesId } });
    await prisma.meeting.deleteMany({ where: { relationId: { in: relations.map((r) => r.id) } } });
    await prisma.meetingSeries.deleteMany({ where: { projectId: project.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relations.map((r) => r.id) } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(menteeA.email);
    await cleanupByEmail(menteeB.email);
    await cleanupByEmail(mentorEmail);
  }
});
