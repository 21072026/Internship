import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #942: GET /api/users?view=mentorAvailability feeds the two admin mentor
// pickers (AssignMentorInline, /admin/mentorship's assign form). A mentor at
// capacity or with acceptingMentees=false must still be returned — never
// dropped from the list — with correct activeMenteeCount/availability so the
// UI can label (not block) the option. See src/lib/mentorAvailability.ts.
test('mentor availability picker view returns at-capacity, not-accepting and available mentors alike', async ({ page }) => {
  const adminEmail = uniqueEmail('mpa-admin');
  const fullMentorEmail = uniqueEmail('mpa-full-mentor');
  const pausedMentorEmail = uniqueEmail('mpa-paused-mentor');
  const openMentorEmail = uniqueEmail('mpa-open-mentor');
  const existingMenteeEmail = uniqueEmail('mpa-existing-mentee');
  const pw = 'AssignPass123';

  await seedUser(adminEmail, pw, 'ADMIN', 'MPA Admin');
  const fullMentor = await seedUser(fullMentorEmail, pw, 'MENTOR', 'MPA Full Mentor');
  const pausedMentor = await seedUser(pausedMentorEmail, pw, 'MENTOR', 'MPA Paused Mentor');
  const openMentor = await seedUser(openMentorEmail, pw, 'MENTOR', 'MPA Open Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'MPA Existing Mentee');

  await prisma.user.update({ where: { id: fullMentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: fullMentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });
  await prisma.user.update({ where: { id: pausedMentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });
  await prisma.user.update({ where: { id: openMentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/users?view=mentorAvailability');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    type Row = { id: string; activeMenteeCount: number; availability: { status: string; capacityKnown: boolean } };
    const byId = new Map((body.users as Row[]).map((u) => [u.id, u]));

    const full = byId.get(fullMentor.id);
    expect(full).toBeTruthy();
    expect(full!.activeMenteeCount).toBe(1);
    expect(full!.availability.status).toBe('at_capacity');
    expect(full!.availability.capacityKnown).toBe(true);

    const paused = byId.get(pausedMentor.id);
    expect(paused).toBeTruthy();
    expect(paused!.activeMenteeCount).toBe(0);
    expect(paused!.availability.status).toBe('not_accepting');

    const open = byId.get(openMentor.id);
    expect(open).toBeTruthy();
    expect(open!.activeMenteeCount).toBe(0);
    expect(open!.availability.status).toBe('available');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: fullMentor.id } });
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(openMentorEmail);
    await cleanupByEmail(pausedMentorEmail);
    await cleanupByEmail(fullMentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
