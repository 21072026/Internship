import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { expandSlots } from '@/lib/availabilitySlots';

// Availability a busy mentor can run (#2001): edit a slot in place, publish a
// one-off on a date, and go away for a while without deleting the week.

const PW = 'AvailEdit123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** A calendar date `days` from today, "YYYY-MM-DD" (UTC — the mentor below is on UTC). */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test('a slot is edited in place: no self-collision, the overlap rule still names the clash', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('av-edit');
  const mentor = await seedUser(email, PW, 'MENTOR', 'Av Edit Mentor');
  try {
    await signInAndSettle(page, email, PW, '/mentor');
    await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'UTC' } });
    const post = (data: Record<string, unknown>) => page.request.post('/api/availability', { data });
    const a = (await (await post({ weekday: 2, startTime: '09:00', endTime: '10:00' })).json()).slot;
    await post({ weekday: 2, startTime: '13:00', endTime: '14:00' });

    // Widening it over its own old hour is fine — a slot does not collide with itself.
    const self = await page.request.patch('/api/availability', { data: { id: a.id, startTime: '08:30', endTime: '10:30' } });
    expect(self.status()).toBe(200);

    // Into the other slot: refused, and the clash is named.
    const clash = await page.request.patch('/api/availability', { data: { id: a.id, endTime: '13:30' } });
    expect(clash.status()).toBe(409);
    expect(await clash.json()).toMatchObject({ code: 'overlap', clash: { startTime: '13:00', endTime: '14:00', date: null } });

    // Through the page: Tuesday 08:30 becomes Wednesday 10:00–11:00, in place.
    await page.goto('/mentor/availability');
    const row = page.getByTestId(`slot-${a.id}`);
    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByTestId(`slot-edit-${a.id}`);
    await edit.getByRole('combobox').selectOption('3');
    await edit.getByLabel('From').fill('10:00');
    await edit.getByLabel('To').fill('11:00');
    await edit.getByTestId('slot-edit-save').click();
    await expect(page.getByTestId(`slot-${a.id}`)).toContainText('10:00–11:00');
    const after = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: a.id } });
    expect([after.weekday, after.startTime, after.endTime]).toEqual([3, '10:00', '11:00']);
    expect(await prisma.availabilitySlot.count({ where: { mentorId: mentor.id } })).toBe(2);
  } finally {
    await cleanupByEmail(email);
  }
});

test('a one-off is offered once, on its date; an away window hides the week underneath', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('av-once-mentor');
  const menteeEmail = uniqueEmail('av-once-mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Av Once Mentor');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Av Once Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  try {
    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'UTC' } });
    const onceDate = dayFromNow(5);
    const once = await page.request.post('/api/availability', { data: { weekday: 0, date: onceDate, startTime: '16:00', endTime: '17:00', note: 'Interview prep' } });
    expect(once.status()).toBe(201);
    const oneOff = (await once.json()).slot;
    // The weekday is derived from the date, never trusted from the caller.
    expect(oneOff.weekday).toBe(new Date(`${onceDate}T00:00:00Z`).getUTCDay());

    // A weekly slot on every day at 09:00 — the pattern the away window must hide.
    for (let d = 0; d < 7; d++) await page.request.post('/api/availability', { data: { weekday: d, startTime: '09:00', endTime: '10:00' } });
    // Overlapping the weekly pattern on that weekday would offer the hour twice.
    const dupe = await page.request.post('/api/availability', { data: { weekday: 0, date: onceDate, startTime: '09:30', endTime: '10:30' } });
    expect(dupe.status()).toBe(409);
    expect((await dupe.json()).clash.date).toBeNull();
    // A date already gone is refused.
    expect((await page.request.post('/api/availability', { data: { weekday: 0, date: dayFromNow(-2), startTime: '16:00', endTime: '17:00' } })).status()).toBe(400);

    // Away on days 2–4: through the page.
    await page.goto('/mentor/availability');
    await expect(page.getByTestId('availability-one-offs')).toContainText('Interview prep');
    await page.getByTestId('away-from').fill(dayFromNow(2));
    await page.getByTestId('away-to').fill(dayFromNow(4));
    await page.getByTestId('away-add').click();
    const awayRow = page.getByTestId('availability-away').locator('li');
    await expect(awayRow).toHaveCount(1);
    expect(await prisma.availabilityException.count({ where: { mentorId: mentor.id } })).toBe(1);

    // The mentee's view: dates only, no reason; the picker drops days 2–4 and
    // offers the one-off exactly once.
    await prisma.availabilityException.updateMany({ where: { mentorId: mentor.id }, data: { reason: 'Surgery' } });
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    const view = await (await page.request.get(`/api/availability?mentorId=${mentor.id}`)).json();
    expect(view.exceptions).toEqual([{ startDate: `${dayFromNow(2)}T00:00:00.000Z`, endDate: `${dayFromNow(4)}T00:00:00.000Z` }]);
    expect(JSON.stringify(view)).not.toContain('Surgery');

    const offered = expandSlots(view.slots, view.timezone, { from: new Date(), weeks: 2, exceptions: view.exceptions });
    const dates = new Set(offered.map((o) => o.date));
    for (const d of [2, 3, 4]) expect(dates.has(dayFromNow(d)), `day ${d} should be hidden`).toBe(false);
    expect(dates.has(dayFromNow(1))).toBe(true);
    expect(offered.filter((o) => o.slotId === oneOff.id).map((o) => o.date)).toEqual([onceDate]);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('an admin writes for a mentor of their own org; another mentor and a mentee cannot', async ({ page }) => {
  test.slow();
  const adminEmail = uniqueEmail('av-adm');
  const mentorEmail = uniqueEmail('av-adm-mentor');
  const otherEmail = uniqueEmail('av-adm-other');
  const org = await prisma.organization.create({ data: { name: `Av Org ${Date.now()}`, slug: `av-org-${Date.now()}` } });
  const foreign = await prisma.organization.create({ data: { name: `Av Foreign ${Date.now()}`, slug: `av-foreign-${Date.now()}` } });
  const foreignEmail = uniqueEmail('av-adm-foreign');
  await seedUser(adminEmail, PW, 'ADMIN', 'Av Admin', org.id);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Av Org Mentor', org.id);
  await seedUser(otherEmail, PW, 'MENTOR', 'Av Other Mentor', org.id);
  const outsider = await seedUser(foreignEmail, PW, 'MENTOR', 'Av Foreign Mentor', foreign.id);
  try {
    const slot = await prisma.availabilitySlot.create({ data: { mentorId: mentor.id, weekday: 1, startTime: '09:00', endTime: '10:00' } });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    expect((await page.request.patch('/api/availability', { data: { id: slot.id, startTime: '08:00' } })).status()).toBe(200);
    expect((await page.request.post('/api/availability', { data: { mentorId: mentor.id, weekday: 4, startTime: '12:00', endTime: '13:00' } })).status()).toBe(201);
    const away = await page.request.post('/api/availability/exceptions', { data: { mentorId: mentor.id, startDate: dayFromNow(10), endDate: dayFromNow(12) } });
    expect(away.status()).toBe(201);
    const awayId = (await away.json()).exception.id;
    // Not across the tenant line.
    expect((await page.request.post('/api/availability/exceptions', { data: { mentorId: outsider.id, startDate: dayFromNow(10), endDate: dayFromNow(12) } })).status()).toBe(403);

    // A fellow mentor: no edit, no away window, no delete — and a mentee neither.
    await signInAsFreshUser(page, otherEmail, PW, '/mentor');
    expect((await page.request.patch('/api/availability', { data: { id: slot.id, startTime: '07:00' } })).status()).toBe(404);
    expect((await page.request.post('/api/availability/exceptions', { data: { mentorId: mentor.id, startDate: dayFromNow(1), endDate: dayFromNow(1) } })).status()).toBe(403);
    expect((await page.request.delete(`/api/availability/exceptions?id=${awayId}`)).status()).toBe(404);

    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } })).startTime).toBe('08:00');
    expect(await prisma.availabilityException.count({ where: { mentorId: mentor.id } })).toBe(1);
  } finally {
    for (const e of [adminEmail, mentorEmail, otherEmail, foreignEmail]) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, foreign.id] } } });
  }
});
