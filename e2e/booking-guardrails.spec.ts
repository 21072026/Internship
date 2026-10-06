import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// Booking guardrails (#2003): a mentor draws the line once — notice, caps, a
// gap between calls, a session length — and every write path holds it. The
// mentor's own bookings are exempt; an admin may force past a rule, and that
// is recorded; a mentee is told which rule, in a sentence.

const PW = 'Guardrails123!';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Next week's `weekday` (0=Sun) at `hour` UTC — always in one Mon–Sun week, well past any notice. */
function nextWeek(weekday: number, hour: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() + (7 - sinceMonday) * DAY);
  return new Date(monday.getTime() + ((weekday + 6) % 7) * DAY + hour * HOUR);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedWorld(prefix: string) {
  const stamp = `${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `${prefix} ${stamp}`, slug: `${prefix}-${stamp}` } });
  const emails = { admin: uniqueEmail(`${prefix}-admin`), mentor: uniqueEmail(`${prefix}-mentor`), mentee: uniqueEmail(`${prefix}-mentee`) };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', `${prefix} Admin`, org.id);
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `${prefix} Mentor`, org.id);
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `${prefix} Mentee`, org.id);
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id, admin.id] } }, data: { timezone: 'UTC' } });
  const rel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  return {
    org, admin, mentor, mentee, rel, emails,
    meeting: (scheduledAt: Date, title: string) =>
      prisma.meeting.create({ data: { relationId: rel.id, title, scheduledAt, createdById: mentor.id, rsvpToken: randomBytes(16).toString('hex') } }),
    async cleanup() {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: [admin.id, mentor.id] } } });
      await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
      await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
      for (const e of Object.values(emails)) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    },
  };
}

test('the mentor sets the rules once; short notice and a full week are refused by name', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const w = await seedWorld('bg-rules');
  try {
    // The card is the one place the rules are set; its summary reads them back.
    await signInAndSettle(page, w.emails.mentor, PW, '/mentor');
    await prisma.user.update({ where: { id: w.mentor.id }, data: { timezone: 'UTC' } });
    await page.goto('/mentor/availability');
    const card = page.getByTestId('booking-rules');
    await card.getByTestId('rules-slot').fill('30');
    await card.getByTestId('rules-notice').fill('4');
    await card.getByTestId('rules-week').fill('2');
    await card.getByTestId('booking-rules-save').click();
    await expect(card.getByTestId('booking-rules-summary')).toHaveText('Bookings: 30-minute sessions, at least 4 hours ahead, up to 2 a week.');
    expect(await prisma.mentorBookingPolicy.findUnique({ where: { mentorId: w.mentor.id } })).toMatchObject({ minNoticeMinutes: 240, maxPerWeek: 2, defaultSlotMinutes: 30, maxPerMonth: null });
    // A monthly cap below the weekly one is refused.
    expect((await page.request.put('/api/availability/policy', { data: { minNoticeMinutes: 240, bufferMinutes: null, maxPerWeek: 2, maxPerMonth: 1, defaultSlotMinutes: 30 } })).status()).toBe(400);

    // Two meetings already in next week.
    await w.meeting(nextWeek(2, 9), 'Tuesday');
    await w.meeting(nextWeek(4, 9), 'Thursday');

    await signInAsFreshUser(page, w.emails.mentee, PW, '/portal');
    const ask = (at: Date) => page.request.post('/api/meeting-requests', { data: { relationId: w.rel.id, topic: 'Career', proposedAt: at.toISOString() } });
    // An hour from now: inside the four-hour notice.
    const short = await ask(new Date(Date.now() + HOUR));
    expect(short.status()).toBe(409);
    expect(await short.json()).toMatchObject({ code: 'policy', rule: 'min_notice', limit: 240 });
    // Wednesday of next week: the week already has two.
    const full = await ask(nextWeek(3, 14));
    expect(full.status()).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'policy', rule: 'weekly_cap', limit: 2, windowStart: nextWeek(1, 0).toISOString() });
    // The week after is fine.
    expect((await ask(new Date(nextWeek(3, 14).getTime() + 7 * DAY))).status()).toBe(201);

    // And the panel says it in a sentence, named after the mentor.
    await page.goto('/portal/requests');
    await page.getByLabel(/Topic|Konu|Thema/).fill('Quick question');
    // The browser's clock reads the field; an hour from now on it.
    const soon = new Date(Date.now() + HOUR);
    const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel(/Proposed time|Önerilen zaman|Vorgeschlagene Zeit/).fill(local);
    await page.getByRole('button', { name: /^(Request|Talep et|Anfragen)$/ }).click();
    await expect(page.getByTestId('meeting-policy')).toContainText('needs at least 4 hours notice');
  } finally {
    await w.cleanup();
  }
});

test('a buffer keeps the gap; the offer shrinks to match; the mentor is exempt and an admin forces on the record', async ({ page }) => {
  test.slow();
  const w = await seedWorld('bg-buffer');
  try {
    await prisma.mentorBookingPolicy.create({ data: { mentorId: w.mentor.id, bufferMinutes: 15, defaultSlotMinutes: 30, maxPerWeek: 2 } });
    const existing = nextWeek(3, 14); // Wed 14:00–15:00
    await w.meeting(existing, 'Existing');
    await prisma.availabilitySlot.create({ data: { mentorId: w.mentor.id, weekday: 3, startTime: '13:00', endTime: '17:00' } });

    await signInAndSettle(page, w.emails.mentee, PW, '/portal');
    const ask = (at: Date) => page.request.post('/api/meeting-requests', { data: { relationId: w.rel.id, topic: 'Gap', proposedAt: at.toISOString() } });
    const tooClose = await ask(new Date(existing.getTime() + HOUR + 10 * 60_000)); // 15:10
    expect(tooClose.status()).toBe(409);
    expect(await tooClose.json()).toMatchObject({ rule: 'buffer', limit: 15, windowStart: existing.toISOString() });
    // The offer side agrees: 30-minute blocks, the meeting widened by 15 minutes.
    const avail = await (await page.request.get(`/api/availability?mentorId=${w.mentor.id}`)).json();
    expect(avail.booking).toEqual({ slotMinutes: 30, minNoticeMinutes: null });
    expect(avail.busy).toContainEqual({ start: new Date(existing.getTime() - 15 * 60_000).toISOString(), end: new Date(existing.getTime() + 75 * 60_000).toISOString() });
    expect(JSON.stringify(avail)).not.toContain('maxPerWeek');

    // A clear time is requested; accepting it makes a 30-minute meeting.
    const ok = await ask(new Date(existing.getTime() + 2 * HOUR)); // 16:00
    expect(ok.status()).toBe(201);
    const reqId = (await ok.json()).request.id;

    // The admin is bound: the week now holds 1, a second booking fills it, a third is refused.
    await signInAsFreshUser(page, w.emails.admin, PW, '/admin');
    const book = (at: Date, force = false) =>
      page.request.post('/api/meetings', { data: { relationIds: [w.rel.id], title: 'Admin booked', scheduledAt: at.toISOString(), ...(force ? { force: true } : {}) } });
    expect((await book(nextWeek(5, 10))).ok()).toBeTruthy(); // Friday — 2 of 2
    const over = await book(nextWeek(5, 13));
    expect(over.status()).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'policy', rule: 'weekly_cap' });
    // …and an admin accepting the pending request is bound too.
    const accept = await page.request.patch(`/api/meeting-requests/${reqId}`, { data: { action: 'accept' } });
    expect(accept.status()).toBe(409);
    expect((await accept.json()).rule).toBe('weekly_cap');
    // Forced: booked, and on the record.
    expect((await book(nextWeek(5, 13), true)).ok()).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { actorId: w.admin.id, action: 'meeting.forcePolicy' } })).toBe(1);

    // The mentor's own call is exempt: accepting over their own cap works, at their length.
    await signInAsFreshUser(page, w.emails.mentor, PW, '/mentor');
    const mine = await page.request.patch(`/api/meeting-requests/${reqId}`, { data: { action: 'accept' } });
    expect(mine.ok()).toBeTruthy();
    const made = await prisma.meeting.findUniqueOrThrow({ where: { id: (await mine.json()).meetingId } });
    expect(made.durationMinutes).toBe(30);
  } finally {
    await w.cleanup();
  }
});
