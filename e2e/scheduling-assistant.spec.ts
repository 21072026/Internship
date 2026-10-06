import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { parseWallClockInZone } from '@/lib/timezone';

// The scheduling assistant (#1999): times free for both people, inside
// 08:00–20:00 on each one's clock, soonest first — and picking one books
// through the existing request path, with nothing learnt about the mentor's
// other commitments beyond "not offered".

const PW = 'Assistant123!';
const DAY = 24 * 3_600_000;

/** Next week's Wednesday, 00:00 UTC. */
function nextWednesday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() + (7 - sinceMonday + 2) * DAY);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('suggestions skip busy hours and night-time clocks, say why when empty, and a pick books through the request path', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `SA ${stamp}`, slug: `sa-${stamp}` } });
  const emails = { mentor: uniqueEmail('sa-mentor'), mentee: uniqueEmail('sa-mentee'), other: uniqueEmail('sa-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'SA Mentor', org.id);
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'SA Mentee', org.id);
  const other = await seedUser(emails.other, PW, 'MENTEE', 'SA Other', org.id);
  const rel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const otherRel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: other.id } });
  try {
    // Mentor in Berlin with Wednesdays 09:00–12:00; the mentee in Istanbul.
    await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'Europe/Berlin' } });
    await prisma.availabilitySlot.create({ data: { mentorId: mentor.id, weekday: 3, startTime: '09:00', endTime: '12:00' } });
    const wed = nextWednesday();
    // A Berlin wall clock on that Wednesday, resolved the way the app does it.
    const at = (berlinHour: number) => parseWallClockInZone(`${wed.toISOString().slice(0, 10)}T${String(berlinHour).padStart(2, '0')}:00`, 'Europe/Berlin')!;
    // 10:00 Berlin is taken — by another mentee, with a private title.
    await prisma.meeting.create({ data: { relationId: otherRel.id, title: 'Private: salary talk', scheduledAt: at(10), createdById: mentor.id, rsvpToken: randomBytes(16).toString('hex') } });

    await signInAndSettle(page, emails.mentee, PW, '/portal');
    await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'Europe/Istanbul' } });
    const read = async () => (await page.request.get(`/api/meetings/suggested-times?relationId=${rel.id}&count=10`)).json();

    const first = await read();
    expect(first.reason).toBeNull();
    const starts = first.suggestions.map((s: { startISO: string }) => s.startISO);
    expect(starts).toContain(at(9).toISOString());
    expect(starts).toContain(at(11).toISOString());
    expect(starts).not.toContain(at(10).toISOString());
    expect(JSON.stringify(first)).not.toContain('salary');

    // A mentee in New York: 09:00–12:00 Berlin is 03:00–06:00 there. Nothing — and it says why.
    await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'America/New_York' } });
    expect(await read()).toMatchObject({ suggestions: [], reason: 'outside_hours' });
    await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'Europe/Istanbul' } });

    // Someone else's relation is not this mentee's to ask about.
    expect((await page.request.get(`/api/meetings/suggested-times?relationId=${otherRel.id}`)).status()).toBe(404);

    // Pick the first suggestion in the panel: both clocks show, and the request
    // goes through the existing POST at exactly that instant.
    await page.goto('/portal/requests');
    const strip = page.getByTestId('suggested-times');
    await strip.getByTestId('suggested-time').first().click();
    await expect(strip.getByTestId('attendee-times')).toContainText('SA Mentor');
    await page.getByLabel(/Topic|Konu|Thema/).fill('Picked for us');
    await page.getByRole('button', { name: /^(Request|Talep et|Anfragen)$/ }).click();
    await expect
      .poll(async () => (await prisma.meetingRequest.findFirst({ where: { relationId: rel.id } }))?.proposedAt?.toISOString(), { timeout: 15_000 })
      .toBe(first.suggestions[0].startISO);

    // With the mentor's hours all taken, the empty state names that instead.
    for (const h of [9, 11]) {
      await prisma.meeting.create({ data: { relationId: otherRel.id, title: 'Busy', scheduledAt: at(h), createdById: mentor.id, rsvpToken: randomBytes(16).toString('hex') } });
    }
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await prisma.availabilitySlot.create({ data: { mentorId: mentor.id, date: wed, weekday: 3, startTime: '09:00', endTime: '12:00' } });
    expect(await read()).toMatchObject({ suggestions: [], reason: 'all_taken' });
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: { in: [rel.id, otherRel.id] } } });
    await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [rel.id, otherRel.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
