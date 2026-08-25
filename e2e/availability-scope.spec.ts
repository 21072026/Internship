import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * `/api/availability?mentorId=` used to hand ANY signed-in account ANY mentor's
 * weekly hours, across organizations (#1350).
 *
 * `AvailabilitySlot` carries no `orgId` and is not one of orgContext's
 * TENANT_MODELS, so the central isolation middleware never saw the query — the
 * row is only reachable as a tenant row through `mentorId → User`, and nothing
 * made that hop. These tests are that hop, asserted from the outside.
 *
 * Everything goes through `page.request`, which carries the signed-in session
 * cookie, because the leak is in the endpoint rather than in any screen: no UI
 * has ever passed `?mentorId=`, which is exactly why nothing caught this.
 */

const PASSWORD = 'AvailScope123!';

async function seedOrgWithMentor(prefix: string) {
  const org = await prisma.organization.create({
    data: { slug: `${prefix}-${Date.now()}-${Math.round(performance.now())}`, name: `${prefix} Org` },
  });
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', `${prefix} Mentor`);
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId: org.id } });
  await prisma.availabilitySlot.create({
    data: { mentorId: mentor.id, weekday: 2, startTime: '10:00', endTime: '11:00' },
  });
  return { org, mentor, mentorEmail };
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentee in another organization cannot read a mentor’s hours', async ({ page }) => {
  const a = await seedOrgWithMentor('scope-a');
  const b = await seedOrgWithMentor('scope-b');
  const intruderEmail = uniqueEmail('scope-b-mentee');
  const intruder = await seedUser(intruderEmail, PASSWORD, 'MENTEE', 'Scope B Mentee');
  await prisma.user.update({ where: { id: intruder.id }, data: { orgId: b.org.id } });

  try {
    await signInAndSettle(page, intruderEmail, PASSWORD, '/portal');

    // The cross-tenant read: org B's mentee asking for org A's mentor.
    const res = await page.request.get(`/api/availability?mentorId=${a.mentor.id}`);
    // 404 rather than 403 on purpose — a 403 would confirm the id exists.
    expect(res.status()).toBe(404);

    // Its own org's mentor is refused too, because no relation and no directory
    // consent: being in the same tenant is necessary, not sufficient.
    const sameOrg = await page.request.get(`/api/availability?mentorId=${b.mentor.id}`);
    expect(sameOrg.status()).toBe(404);

    // And its own (empty) hours still come back, so the gate did not break the
    // ordinary path.
    const own = await page.request.get('/api/availability');
    expect(own.status()).toBe(200);
    expect((await own.json()).slots).toEqual([]);
  } finally {
    await cleanupByEmail(intruderEmail);
    for (const seeded of [a, b]) {
      await cleanupByEmail(seeded.mentorEmail);
      await prisma.organization.delete({ where: { id: seeded.org.id } }).catch(() => {});
    }
  }
});

test('the mentee actually paired with the mentor does get the hours', async ({ page }) => {
  const a = await seedOrgWithMentor('scope-paired');
  const menteeEmail = uniqueEmail('scope-paired-mentee');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Scope Paired Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: a.org.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: a.mentor.id, menteeId: mentee.id, orgId: a.org.id, status: 'ACTIVE' },
  });

  try {
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');
    const res = await page.request.get(`/api/availability?mentorId=${a.mentor.id}`);
    expect(res.status()).toBe(200);
    const { slots } = await res.json();
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ weekday: 2, startTime: '10:00', endTime: '11:00' });

    // Ending the relation ends the access — the gate reads live state, it does
    // not remember that these two were once paired.
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { status: 'COMPLETED' } });
    const after = await page.request.get(`/api/availability?mentorId=${a.mentor.id}`);
    expect(after.status()).toBe(404);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(a.mentorEmail);
    await prisma.organization.delete({ where: { id: a.org.id } }).catch(() => {});
  }
});

test('an admin cannot delete a slot belonging to another organization', async ({ page }) => {
  const a = await seedOrgWithMentor('scope-del-a');
  const b = await seedOrgWithMentor('scope-del-b');
  const adminEmail = uniqueEmail('scope-del-admin');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Scope Del Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: b.org.id } });
  const victim = await prisma.availabilitySlot.findFirstOrThrow({ where: { mentorId: a.mentor.id } });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    const res = await page.request.delete(`/api/availability?id=${victim.id}`);
    expect(res.status()).toBe(403);
    // Refused, and the row is still there — a 403 that deleted anyway would be
    // the worse bug.
    expect(await prisma.availabilitySlot.count({ where: { id: victim.id } })).toBe(1);

    // The same admin may still delete inside its own organization.
    const own = await prisma.availabilitySlot.findFirstOrThrow({ where: { mentorId: b.mentor.id } });
    const ok = await page.request.delete(`/api/availability?id=${own.id}`);
    expect(ok.status()).toBe(200);
    expect(await prisma.availabilitySlot.count({ where: { id: own.id } })).toBe(0);
  } finally {
    await cleanupByEmail(adminEmail);
    for (const seeded of [a, b]) {
      await cleanupByEmail(seeded.mentorEmail);
      await prisma.organization.delete({ where: { id: seeded.org.id } }).catch(() => {});
    }
  }
});

/**
 * #1363 — a slot carries no zone of its own and is read in the mentor's
 * `User.timezone`; overlapping intervals on the same weekday are refused.
 */
test('the screen names the time zone the hours are read in', async ({ page }) => {
  const mentorEmail = uniqueEmail('avail-zone-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Avail Zone Mentor');

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    // A chosen zone is stated plainly, with no prompt.
    await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'Europe/Berlin' } });
    await page.goto('/mentor/availability');
    const banner = page.getByTestId('availability-zone');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Europe/Berlin');
    await expect(banner.getByRole('link')).toHaveCount(0);

    // With none saved, the copy must NOT present the fallback as the mentor's
    // own, and must offer the way to set one.
    //
    // Clearing it after sign-in is deliberate: TimezoneSync (#1030) posts the
    // browser zone on the first authenticated load, so a freshly seeded mentor
    // already has one by the time any page renders. It only posts once per
    // browser session, so the reload below leaves the column null.
    await prisma.user.update({ where: { id: mentor.id }, data: { timezone: null } });
    await page.reload();
    await expect(banner.getByRole('link')).toBeVisible();
    // The fallback zone is deployment configuration (APP_TIMEZONE), so assert
    // that the banner agrees with what the endpoint resolved rather than
    // hard-coding a zone this runner may not use.
    const { timezone, timezoneSet } = await (await page.request.get('/api/availability')).json();
    expect(timezoneSet).toBe(false);
    await expect(banner).toContainText(timezone);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

test('an overlapping slot is refused and no row is created', async ({ page }) => {
  const mentorEmail = uniqueEmail('avail-overlap-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Avail Overlap Mentor');

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    const post = (data: Record<string, unknown>) => page.request.post('/api/availability', { data });

    expect((await post({ weekday: 1, startTime: '09:00', endTime: '11:00' })).status()).toBe(201);

    // Straddling, contained, identical — all overlaps.
    for (const range of [
      { startTime: '10:00', endTime: '12:00' },
      { startTime: '09:30', endTime: '10:30' },
      { startTime: '09:00', endTime: '11:00' },
      { startTime: '08:00', endTime: '13:00' },
    ]) {
      const res = await post({ weekday: 1, ...range });
      expect(res.status(), `${range.startTime}-${range.endTime} should clash`).toBe(409);
      expect((await res.json()).code).toBe('overlap');
    }

    // Back-to-back is not an overlap — the comparison is half-open, which is how
    // a person reads 09:00–10:00 followed by 10:00–11:00.
    expect((await post({ weekday: 1, startTime: '11:00', endTime: '12:00' })).status()).toBe(201);
    // Same clock, different day, is fine.
    expect((await post({ weekday: 2, startTime: '09:00', endTime: '11:00' })).status()).toBe(201);

    // Exactly the three that were accepted, so no refusal wrote a row anyway.
    expect(await prisma.availabilitySlot.count({ where: { mentorId: mentor.id } })).toBe(3);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
