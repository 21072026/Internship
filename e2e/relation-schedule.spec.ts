import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi } from './helpers/auth';

// What a pairing agreed to (#1784): an admin creates a pairing with a 6-month
// duration and a fortnightly rhythm, the mentee's portal shows both, an edit
// of the end date is not an extension, a mentor of another pairing gets 403,
// and a pairing that joins a programme takes the programme's default duration.

test.afterAll(async () => prisma.$disconnect());

const PW = 'SchedulePass123!';

test('agreed end date and rhythm: set at match time, shown to the mentee, editable by an admin only', async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const emails = ['sched-admin', 'sched-mentor', 'sched-mentee', 'sched-other', 'sched-mentee2'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail, otherEmail, mentee2Email] = emails;
  let cohortId = '';
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Sched Admin');
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Sched Mentor');
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Sched Mentee');
    await seedUser(otherEmail, PW, 'MENTOR', 'Other Mentor');
    const mentee2 = await seedUser(mentee2Email, PW, 'MENTEE', 'Sched Mentee Two');

    expect((await signInViaApi(request, adminEmail, PW)).ok).toBe(true);
    const created = await request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id, durationMonths: 6, expectedMeetingIntervalWeeks: 2 },
    });
    expect(created.ok()).toBeTruthy();
    const relationId: string = (await created.json()).relation.id;
    const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
    expect(row.expectedMeetingIntervalWeeks).toBe(2);
    expect(row.expectedEndDate).not.toBeNull();
    const months = (row.expectedEndDate!.getUTCFullYear() - row.startDate.getUTCFullYear()) * 12 + row.expectedEndDate!.getUTCMonth() - row.startDate.getUTCMonth();
    expect(months).toBe(6);

    // Without either field the pairing is created exactly as before.
    const plain = await request.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: mentee2.id } });
    expect(plain.ok()).toBeTruthy();
    const plainRow = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: mentee2.id } });
    expect(plainRow).toMatchObject({ expectedEndDate: null, expectedMeetingIntervalWeeks: null, durationExtendedCount: 0 });

    // An admin edit moves the date, re-arms the nudge, and is not an extension.
    await prisma.mentorshipRelation.update({ where: { id: relationId }, data: { endingSoonNotifiedAt: new Date() } });
    const edit = await request.put(`/api/mentorship/${relationId}`, { data: { expectedEndDate: '2027-03-14' } });
    expect(edit.ok()).toBeTruthy();
    const edited = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
    expect(edited.expectedEndDate?.toISOString().slice(0, 10)).toBe('2027-03-14');
    expect(edited.endingSoonNotifiedAt).toBeNull();
    expect(edited.durationExtendedCount).toBe(0);

    // A mentor of another pairing may not touch it (the route's rule, unchanged).
    const outsider = await playwrightRequest.newContext({ baseURL });
    try {
      expect((await signInViaApi(outsider, otherEmail, PW)).ok).toBe(true);
      const refused = await outsider.put(`/api/mentorship/${relationId}`, { data: { expectedEndDate: '2030-01-01' } });
      expect(refused.status()).toBe(403);
    } finally {
      await outsider.dispose();
    }

    // Joining a programme fills the empty agreement from the programme's default.
    // The settings layer of an org-less row is the default org's.
    const org =
      (await prisma.user.findUniqueOrThrow({ where: { id: mentee2.id }, select: { orgId: true } })).orgId ??
      (await prisma.organization.findUniqueOrThrow({ where: { slug: 'default' }, select: { id: true } })).id;
    cohortId = (await prisma.cohort.create({ data: { orgId: org, name: `Sched cohort ${Date.now()}` } })).id;
    await prisma.setting.create({ data: { orgId: org, programId: cohortId, key: 'relationDefaultDurationMonths', value: '3' } });
    const join = await request.put(`/api/mentorship/${plainRow.id}`, { data: { cohortId } });
    expect(join.ok()).toBeTruthy();
    const joined = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: plainRow.id } });
    expect(joined.expectedEndDate).not.toBeNull();
    expect(joined.expectedMeetingIntervalWeeks).toBeNull();

    // The mentee reads both, formatted for their locale.
    await signInAndSettle(page, menteeEmail, PW, '/portal');
    const line = page.getByTestId('portal-relation-schedule');
    await expect(line).toBeVisible();
    await expect(line).toContainText('Ends');
    await expect(line).toContainText('03/14/2027');
    await expect(line).toContainText('every 2 weeks');
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    if (cohortId) {
      await prisma.setting.deleteMany({ where: { programId: cohortId } });
      await prisma.cohort.deleteMany({ where: { id: cohortId } });
    }
  }
});
