import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// A standing 1:1 reaches both of its people (#2013, slice 2). Slice 1 put the
// rule on a relation and on both calendars; this pins everything else a
// project's call already did: the mentee is told when it is set up, the banner
// announces it to both, either of them can mark an occurrence over, the
// reminder cron reminds both — each naming the other person and linking their
// own calendar — and the mentor sets it up from the relation page.

const PW = 'RelationSeriesReach1!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

test('a standing 1:1 is announced, bannered, endable and reminded for both of its people', async () => {
  const mentorEmail = uniqueEmail('rsr-mentor');
  const menteeEmail = uniqueEmail('rsr-mentee');
  const adminEmail = uniqueEmail('rsr-admin');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Reach Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Reach Mentee');
  await seedUser(adminEmail, PW, 'ADMIN', 'Reach Admin');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const title = `Reach 1:1 ${Date.now().toString(36)}`;

  // Every day, started five minutes ago, on UTC: today's occurrence is running
  // (the banner shows it, and it can be ended), tomorrow's is inside the
  // reminder's day-before window.
  const target = new Date(Date.now() - 5 * 60 * 1000);
  const hhmm = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;

  const mentorCtx = await ctxFor(mentorEmail);
  const menteeCtx = await ctxFor(menteeEmail);
  const adminCtx = await ctxFor(adminEmail);
  let seriesId = '';
  try {
    const created = await mentorCtx.post('/api/meeting-series', {
      data: { relationId: relation.id, title, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeOfDay: hhmm, timeZone: 'UTC' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    seriesId = body.series.id;
    // Announced to the mentee — the one invite a project call sends each of its
    // mentees. It used to return early for anything without a project.
    expect(body.invitesSent).toBe(1);

    // The reminder cron reminds BOTH, each with the other person as the context
    // line and a link to their own calendar.
    const tick = await adminCtx.get('/api/cron?job=meeting-series-reminders');
    expect(tick.ok()).toBeTruthy();
    const reminders = await prisma.notification.findMany({
      where: { userId: { in: [mentor.id, mentee.id] }, type: 'meeting_reminder.seriesTomorrow' },
      select: { userId: true, params: true, link: true },
    });
    const byUser = new Map(reminders.map((r) => [r.userId, r]));
    expect(byUser.get(mentor.id)?.params).toMatchObject({ title, project: 'Reach Mentee' });
    expect(byUser.get(mentor.id)?.link).toBe('/mentor/calendar');
    expect(byUser.get(mentee.id)?.params).toMatchObject({ title, project: 'Reach Mentor' });
    expect(byUser.get(mentee.id)?.link).toBe('/portal/calendar');
    // Claimed once: a second tick sends nothing more.
    await adminCtx.get('/api/cron?job=meeting-series-reminders');
    expect(
      await prisma.notification.count({ where: { userId: { in: [mentor.id, mentee.id] }, type: 'meeting_reminder.seriesTomorrow' } })
    ).toBe(2);

    // The banner announces it to both of them.
    for (const ctx of [mentorCtx, menteeCtx]) {
      const upcoming = (await (await ctx.get('/api/meetings/upcoming')).json()).meeting;
      expect(upcoming?.title).toBe(title);
      expect(String(upcoming.id)).toContain(`${seriesId}:`);
    }

    // The mentee may mark the occurrence over (not only a project member), and
    // it is over for both.
    const upcoming = (await (await menteeCtx.get('/api/meetings/upcoming')).json()).meeting;
    const end = await menteeCtx.post(`/api/meetings/${encodeURIComponent(upcoming.id)}/end`);
    expect(end.ok()).toBeTruthy();
    for (const ctx of [mentorCtx, menteeCtx]) {
      expect((await (await ctx.get('/api/meetings/upcoming')).json()).meeting).toBeNull();
    }

    // A completed pairing's 1:1 reminds nobody, even with the rule still active.
    await prisma.meetingSeriesReminder.deleteMany({ where: { seriesId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] }, type: 'meeting_reminder.seriesTomorrow' } });
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { status: 'COMPLETED' } });
    await adminCtx.get('/api/cron?job=meeting-series-reminders');
    expect(
      await prisma.notification.count({ where: { userId: { in: [mentor.id, mentee.id] }, type: 'meeting_reminder.seriesTomorrow' } })
    ).toBe(0);
  } finally {
    await mentorCtx.dispose();
    await menteeCtx.dispose();
    await adminCtx.dispose();
    await prisma.meetingOccurrenceEnd.deleteMany({ where: { series: { relationId: relation.id } } });
    await prisma.meetingSeriesReminder.deleteMany({ where: { series: { relationId: relation.id } } });
    await prisma.meetingSeries.deleteMany({ where: { relationId: relation.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of [mentorEmail, menteeEmail, adminEmail]) await cleanupByEmail(e);
  }
});

test('the mentor makes a 1:1 recurring from the relation page — every 2 weeks, three meetings — and stops it', async ({ page }) => {
  const mentorEmail = uniqueEmail('rsr-ui-mentor');
  const menteeEmail = uniqueEmail('rsr-ui-mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Page Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Page Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    await gotoSettled(page, `/mentor/mentees/${relation.id}`);
    const panel = page.getByTestId('relation-series');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    await panel.getByTestId('relation-series-add').click();
    const form = panel.getByTestId('relation-series-form');
    await expect(form).toBeVisible();
    await form.getByTestId('relation-series-interval').selectOption('2');
    await form.getByTestId('relation-series-end-count').check();
    await form.getByTestId('relation-series-count').fill('3');
    await form.getByTestId('relation-series-save').click();
    await expect(form).toBeHidden();

    const row = await prisma.meetingSeries.findFirstOrThrow({ where: { relationId: relation.id, active: true } });
    expect(row).toMatchObject({ projectId: null, intervalWeeks: 2, maxOccurrences: 3, untilDate: null });
    await expect(panel.getByTestId(`relation-series-cadence-${row.id}`)).toHaveText('Every 2 weeks · 3 meetings');
    await expect(panel.getByTestId(`relation-series-next-${row.id}`)).toBeVisible();
    // One standing 1:1 per pairing from this control: the add button is gone.
    await expect(panel.getByTestId('relation-series-add')).toHaveCount(0);

    await panel.getByTestId(`relation-series-stop-${row.id}`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop the series' }).click();
    await expect(panel.getByTestId(`relation-series-${row.id}`)).toHaveCount(0);
    expect((await prisma.meetingSeries.findUniqueOrThrow({ where: { id: row.id } })).active).toBe(false);
  } finally {
    await prisma.meetingSeriesReminder.deleteMany({ where: { series: { relationId: relation.id } } });
    await prisma.meetingSeries.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of [mentorEmail, menteeEmail]) await cleanupByEmail(e);
  }
});
