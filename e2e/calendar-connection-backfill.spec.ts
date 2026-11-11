import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// The provider-neutral calendar tables (#1989, expand). The deploy copies every
// GoogleCalendarConnection and its event links into CalendarConnection /
// CalendarEventLink once; the code reads only the new tables. Pinned here:
// the copy is exact (the sealed tokens byte for byte, so they still decrypt),
// a second run adds nothing, the old rows are left alone (they are the
// rollback), and the new key lets one person hold a Google AND a Microsoft
// connection at the same time.

const PW = 'CalBackfill123!';
const run = () => execFileSync('node', ['prisma/backfill-calendar-connections.mjs'], { env: process.env, encoding: 'utf8' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('Google connections and links are copied once, exactly, and the old rows stay', async () => {
  const email = uniqueEmail('cal-backfill');
  const menteeEmail = uniqueEmail('cal-backfill-mentee');
  const user = await seedUser(email, PW, 'MENTOR', 'Cal Backfill');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Cal Backfill Mentee');
  try {
    const relation = await prisma.mentorshipRelation.create({ data: { mentorId: user.id, menteeId: mentee.id } });
    const old = await prisma.googleCalendarConnection.create({
      data: {
        userId: user.id,
        googleEmail: 'backfill.person@gmail.example',
        scope: 'https://www.googleapis.com/auth/calendar.events',
        accessTokenEnc: 'v1:sealed-access-token-fixture',
        refreshTokenEnc: 'v1:sealed-refresh-token-fixture',
        expiresAt: new Date(Date.now() + 3600_000),
        lastError: 'Previous failure',
      },
    });
    const meeting = await prisma.meeting.create({
      data: { relationId: relation.id, title: 'Backfill meeting', scheduledAt: new Date(), createdById: user.id, rsvpToken: `bf-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    await prisma.googleCalendarEventLink.create({ data: { meetingId: meeting.id, connectionId: old.id, googleEventId: 'google-event-123' } });

    run();

    const copy = await prisma.calendarConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: user.id, provider: 'GOOGLE' } },
      include: { events: true },
    });
    expect(copy.accountEmail).toBe('backfill.person@gmail.example');
    expect(copy.accessTokenEnc).toBe(old.accessTokenEnc);
    expect(copy.refreshTokenEnc).toBe(old.refreshTokenEnc);
    expect(copy.expiresAt.getTime()).toBe(old.expiresAt.getTime());
    expect(copy.scope).toBe(old.scope);
    expect(copy.lastError).toBe('Previous failure');
    expect(copy.events).toHaveLength(1);
    expect(copy.events[0]).toMatchObject({ meetingId: meeting.id, externalEventId: 'google-event-123' });

    // A second run changes nothing — not even a token refreshed in the meantime.
    await prisma.calendarConnection.update({ where: { id: copy.id }, data: { accessTokenEnc: 'v1:refreshed-since' } });
    run();
    expect(await prisma.calendarConnection.count({ where: { userId: user.id } })).toBe(1);
    expect((await prisma.calendarConnection.findUniqueOrThrow({ where: { id: copy.id } })).accessTokenEnc).toBe('v1:refreshed-since');
    expect(await prisma.calendarEventLink.count({ where: { connectionId: copy.id } })).toBe(1);

    // The old rows are the rollback: untouched.
    expect(await prisma.googleCalendarConnection.count({ where: { id: old.id } })).toBe(1);

    // Two providers for one person, neither overwriting the other.
    await prisma.calendarConnection.create({
      data: {
        userId: user.id,
        provider: 'MICROSOFT',
        accountEmail: 'backfill.person@outlook.example',
        scope: 'offline_access User.Read Calendars.ReadWrite',
        accessTokenEnc: 'v1:ms-sealed',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    expect(await prisma.calendarConnection.count({ where: { userId: user.id } })).toBe(2);
    expect((await prisma.calendarConnection.findUniqueOrThrow({ where: { id: copy.id } })).accountEmail).toBe('backfill.person@gmail.example');

    await prisma.meeting.delete({ where: { id: meeting.id } });
  } finally {
    await cleanupByEmail(email);
    await cleanupByEmail(menteeEmail);
  }
});
