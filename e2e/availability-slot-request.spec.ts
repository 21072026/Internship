import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #1361 — closing the loop on availability.
 *
 * The mentor's weekly hours were a dead end in the product: the screen asked
 * for them, the onboarding checklist ticked them off, the landing FAQ promised
 * mentees would book from them, and nothing read them. A mentee now sees those
 * hours as concrete date-times and requests one.
 *
 * The load-bearing assertion is the INSTANT. A slot's wall clock belongs to the
 * mentor's zone; if the picked time were round-tripped through the browser's
 * datetime field it would be re-read on the mentee's clock and the meeting
 * would move by the offset between them. So the test puts the mentee and the
 * mentor in different zones on purpose and checks the stored instant.
 */

const PASSWORD = 'SlotRequest123!';

/** The next occurrence of `weekday` strictly after today, as YYYY-MM-DD in UTC. */
function nextWeekdayUTC(weekday: number, from: Date) {
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== weekday);
  return d;
}

async function seedPair(prefix: string, mentorZone: string, menteeZone: string) {
  const org = await prisma.organization.create({
    data: { slug: `${prefix}-${Date.now()}`, name: `${prefix} Org` },
  });
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', `${prefix} Mentee`);
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId: org.id, timezone: mentorZone } });
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id, timezone: menteeZone } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, status: 'ACTIVE' },
  });
  const cleanup = async () => {
    await prisma.meetingRequest.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, mentor, mentee, mentorEmail, menteeEmail, relation, cleanup };
}

/** TimezoneSync (#1030) overwrites a null zone on first load; pin ours back. */
async function pinZone(userId: string, zone: string) {
  await prisma.user.update({ where: { id: userId }, data: { timezone: zone } });
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentee requests one of the mentor’s posted hours, at the right instant', async ({ page }) => {
  // Deliberately different zones, three hours apart.
  const s = await seedPair('slotreq', 'Europe/Istanbul', 'Europe/London');
  // Wednesday 14:00 in the mentor's zone.
  await prisma.availabilitySlot.create({
    data: { mentorId: s.mentor.id, weekday: 3, startTime: '14:00', endTime: '15:00' },
  });

  try {
    await signInAndSettle(page, s.menteeEmail, PASSWORD, '/portal');
    await pinZone(s.mentee.id, 'Europe/London');
    await page.goto('/portal/requests');

    const offers = page.getByTestId('slot-offers');
    await expect(offers).toBeVisible({ timeout: 15_000 });
    // The zone line has to name the mentor's zone, not the mentee's — the whole
    // point is that the hours belong to someone else's clock.
    await expect(offers).toContainText('Europe/Istanbul');

    // The soonest Wednesday 14:00 Istanbul == 11:00 UTC.
    const expected = nextWeekdayUTC(3, new Date());
    expected.setUTCHours(11, 0, 0, 0);
    const chip = page.getByTestId(`slot-offer-${expected.toISOString()}`);
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    await page.getByLabel(/Topic|Konu|Thema/).fill('Slot booking');
    await page.getByRole('button', { name: /^(Request|Talep et|Anfragen)$/ }).click();

    // The stored instant is the slot's, not a re-read of a browser wall clock.
    await expect
      .poll(async () => {
        const r = await prisma.meetingRequest.findFirst({
          where: { relationId: s.relation.id },
          select: { proposedAt: true },
        });
        return r?.proposedAt?.toISOString() ?? null;
      }, { timeout: 15_000 })
      .toBe(expected.toISOString());
  } finally {
    await s.cleanup();
  }
});

test('the mentor sees that the request landed on their own hours', async ({ page }) => {
  const s = await seedPair('slotmark', 'Europe/Istanbul', 'Europe/Istanbul');
  await prisma.availabilitySlot.create({
    data: { mentorId: s.mentor.id, weekday: 3, startTime: '14:00', endTime: '15:00' },
  });
  const onSlot = nextWeekdayUTC(3, new Date());
  onSlot.setUTCHours(11, 30, 0, 0); // 14:30 Istanbul — inside the slot
  const offSlot = new Date(onSlot);
  offSlot.setUTCHours(6, 0, 0, 0); // 09:00 Istanbul — outside it

  const inSlot = await prisma.meetingRequest.create({
    data: { relationId: s.relation.id, requestedById: s.mentee.id, topic: 'On the hour', proposedAt: onSlot },
  });
  const outSlot = await prisma.meetingRequest.create({
    data: { relationId: s.relation.id, requestedById: s.mentee.id, topic: 'Off the hour', proposedAt: offSlot },
  });

  try {
    await signInAndSettle(page, s.mentorEmail, PASSWORD, '/mentor');
    await pinZone(s.mentor.id, 'Europe/Istanbul');
    await page.goto(`/mentor/mentees/${s.relation.id}`);

    await expect(page.getByTestId(`mreq-from-slot-${inSlot.id}`)).toBeVisible({ timeout: 15_000 });
    // The marker is derived from the live slot, so a request that merely exists
    // does not get it.
    await expect(page.getByTestId(`mreq-from-slot-${outSlot.id}`)).toHaveCount(0);

    // Delete the slot and the claim goes with it — nothing is stored on the
    // request that would keep asserting "this was one of your hours".
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: s.mentor.id } });
    await page.reload();
    await expect(page.getByTestId(`mreq-${inSlot.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mreq-from-slot-${inSlot.id}`)).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('a mentor with no posted hours leaves the free-text request working', async ({ page }) => {
  // The regression that matters most: this flow existed before #1361 and must
  // not become conditional on availability being filled in.
  const s = await seedPair('slotnone', 'Europe/Istanbul', 'Europe/Istanbul');

  try {
    await signInAndSettle(page, s.menteeEmail, PASSWORD, '/portal');
    await page.goto('/portal/requests');

    await expect(page.getByTestId('slot-offers')).toHaveCount(0);
    await page.getByLabel(/Topic|Konu|Thema/).fill('Free text still works');
    await page.getByLabel(/Proposed time|Önerilen zaman|Vorgeschlagene Zeit/).fill('2026-12-01T10:00');
    await page.getByRole('button', { name: /^(Request|Talep et|Anfragen)$/ }).click();

    await expect
      .poll(async () => prisma.meetingRequest.count({ where: { relationId: s.relation.id } }), { timeout: 15_000 })
      .toBe(1);
  } finally {
    await s.cleanup();
  }
});
