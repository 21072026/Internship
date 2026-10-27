import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// Group sessions and office hours (#1856): publish → register to capacity →
// waitlist → cancel → promote, through the API, against a real database.
// The race the issue names is exercised for real: two registrations for the
// last seat are sent at once, and exactly one of them may get it.

const PASSWORD = 'GroupSession123!';

test.describe('group sessions', () => {
  let orgId: string;
  const emails: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const contexts: APIRequestContext[] = [];

  test.beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const org = await prisma.organization.create({ data: { name: `Events Org ${stamp}`, slug: `events-${stamp}`, vertical: 'INTERNSHIP' } });
    orgId = org.id;
    const people: [string, 'ADMIN' | 'MENTOR' | 'MENTEE'][] = [
      ['host', 'MENTOR'],
      ['otherMentor', 'MENTOR'],
      ['a', 'MENTEE'],
      ['b', 'MENTEE'],
      ['c', 'MENTEE'],
    ];
    for (const [key, role] of people) {
      emails[key] = uniqueEmail(`events-${key}`);
      ids[key] = (await seedUser(emails[key], PASSWORD, role, `Events ${key}`, orgId)).id;
    }
  });

  test.afterAll(async () => {
    for (const ctx of contexts) await ctx.dispose();
    await prisma.programEvent.deleteMany({ where: { orgId } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  async function as(playwright: { request: { newContext: () => Promise<APIRequestContext> } }, key: string) {
    const ctx = await playwright.request.newContext();
    contexts.push(ctx);
    const signed = await signInViaApi(ctx, emails[key], PASSWORD);
    expect(signed.ok, `${key} signs in`).toBe(true);
    return ctx;
  }

  test('publish → register to capacity → waitlist → cancel → promote, and attendance', async ({ playwright }) => {
    const host = await as(playwright, 'host');
    const [a, b, c, otherMentor] = await Promise.all([as(playwright, 'a'), as(playwright, 'b'), as(playwright, 'c'), as(playwright, 'otherMentor')]);

    const startsAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
    const created = await host.post('/api/events', {
      data: { title: 'Office hour', startsAt, timeZone: 'Europe/Berlin', durationMinutes: 45, capacity: 1, audience: 'MENTEES', publish: true, joinUrl: 'https://meet.example.com/office-hour' },
    });
    expect(created.status()).toBe(201);
    const eventId = (await created.json()).event.id as string;

    // The audience is told, in their own bell.
    await expect.poll(() => prisma.notification.count({ where: { userId: ids.a, type: 'event.published' } })).toBe(1);

    // A mentor is not the audience of a mentee session: it is not even visible.
    expect((await otherMentor.post(`/api/events/${eventId}/register`)).status()).toBe(404);
    // The host does not take a seat at their own session.
    expect((await host.post(`/api/events/${eventId}/register`)).status()).toBe(409);

    // Two people for the last seat, at once: one seat, one waitlist spot.
    const [ra, rb] = await Promise.all([a.post(`/api/events/${eventId}/register`), b.post(`/api/events/${eventId}/register`)]);
    const states = [(await ra.json()).state, (await rb.json()).state].sort();
    expect(states).toEqual(['REGISTERED', 'WAITLISTED']);
    const [first, second] = (await ra.json()).state === 'REGISTERED' ? [a, b] : [b, a];
    const secondId = second === a ? ids.a : ids.b;

    // Past capacity: waitlisted, never overbooked. A repeat click is not a second place.
    expect((await (await c.post(`/api/events/${eventId}/register`)).json()).state).toBe('WAITLISTED');
    const again = await c.post(`/api/events/${eventId}/register`);
    expect(again.status()).toBe(200);
    expect((await again.json()).alreadyRegistered).toBe(true);
    const row = await prisma.programEvent.findUniqueOrThrow({ where: { id: eventId }, select: { seatsTaken: true } });
    expect(row.seatsTaken).toBe(1);

    // The join link reaches only a confirmed registrant (and the host).
    expect((await (await second.get(`/api/events/${eventId}`)).json()).event.joinUrl).toBeNull();
    expect((await (await first.get(`/api/events/${eventId}`)).json()).event.joinUrl).toBe('https://meet.example.com/office-hour');
    // A participant gets no participant list, and nobody's registration token — there is none.
    const asParticipant = await (await first.get(`/api/events/${eventId}`)).json();
    expect(asParticipant.participants).toBeUndefined();
    expect(JSON.stringify(asParticipant)).not.toMatch(/token/i);

    // The seat holder gives it up: the FIRST person waiting is promoted and told.
    expect((await first.delete(`/api/events/${eventId}/register`)).status()).toBe(200);
    expect((await (await second.get(`/api/events/${eventId}`)).json()).event.myRegistration.state).toBe('REGISTERED');
    expect((await (await c.get(`/api/events/${eventId}`)).json()).event.myRegistration.state).toBe('WAITLISTED');
    await expect.poll(() => prisma.notification.count({ where: { userId: secondId, type: 'event.promoted' } })).toBe(1);

    // Raising the cap fills from the waitlist too.
    expect((await host.patch(`/api/events/${eventId}`, { data: { capacity: 2 } })).status()).toBe(200);
    expect((await (await c.get(`/api/events/${eventId}`)).json()).event.myRegistration.state).toBe('REGISTERED');
    // …and lowering it below the people already in is refused.
    expect((await host.patch(`/api/events/${eventId}`, { data: { capacity: 1 } })).status()).toBe(409);

    // Attendance waits for the session; then the host records it and the participant reads it back.
    expect((await host.patch(`/api/events/${eventId}/attendance`, { data: { userId: ids.c, attendance: 'ATTENDED' } })).status()).toBe(409);
    await prisma.programEvent.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await c.patch(`/api/events/${eventId}/attendance`, { data: { userId: ids.c, attendance: 'ATTENDED' } })).status()).toBe(404);
    expect((await host.patch(`/api/events/${eventId}/attendance`, { data: { userId: ids.c, attendance: 'ATTENDED' } })).status()).toBe(200);
    const participants = (await (await host.get(`/api/events/${eventId}`)).json()).participants as { userId: string; attendance: string | null }[];
    expect(participants.find((p) => p.userId === ids.c)?.attendance).toBe('ATTENDED');
    const past = (await (await c.get('/api/events?when=past')).json()).events as { id: string; myRegistration: { attendance: string } }[];
    expect(past.find((e) => e.id === eventId)?.myRegistration.attendance).toBe('ATTENDED');
  });

  test('a mentee registers from the portal and is told about the group video limit', async ({ page, playwright }) => {
    const host = await as(playwright, 'host');
    const startsAt = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
    // No pasted link, no place: the room comes from resolveMeetingLink().
    const created = await host.post('/api/events', {
      data: { title: 'Kickoff briefing', startsAt, timeZone: 'Europe/Berlin', durationMinutes: 30, capacity: 5, audience: 'MENTEES', publish: true },
    });
    expect(created.status()).toBe(201);
    const eventId = (await created.json()).event.id as string;

    await signInAndSettle(page, emails.a, PASSWORD, '/portal');
    await gotoSettled(page, '/portal/events');
    const card = page.getByTestId(`event-card-${eventId}`);
    await expect(card).toContainText('Kickoff briefing');
    await card.getByTestId(`event-register-${eventId}`).click();
    await expect(card.getByTestId(`event-my-state-${eventId}`)).toBeVisible();
    await expect(card.getByTestId(`event-seats-${eventId}`)).toContainText('1/5');
    // A confirmed registrant gets the link; on the public Jitsi server the five-minute limit is stated.
    const link = (await (await page.request.get(`/api/events/${eventId}`)).json()).event.joinUrl as string;
    expect(link).toBeTruthy();
    if (new URL(link).hostname === 'meet.jit.si') await expect(card.getByTestId(`event-video-note-${eventId}`)).toBeVisible();
  });
});
