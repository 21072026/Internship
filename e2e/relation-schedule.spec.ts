import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * What a pair agreed at the match (#1784): a planned length and a meeting
 * rhythm, set on the creation paths, editable afterwards by the admin or the
 * pair's mentor (never as an "extension"), and shown read-only to the mentee.
 */

const PASSWORD = 'Schedule123!';
const DAY = 24 * 60 * 60 * 1000;

async function signedIn(email: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await signInViaApi(ctx, email, PASSWORD, { headers: freshIp('relation-schedule') })).ok, `sign-in as ${email}`).toBe(true);
  return ctx;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a 6-month, fortnightly pairing shows both to the mentee; edits are not extensions', async ({ page, baseURL }) => {
  const adminEmail = uniqueEmail('sched-admin');
  const mentorEmail = uniqueEmail('sched-mentor');
  const otherMentorEmail = uniqueEmail('sched-other');
  const menteeEmail = uniqueEmail('sched-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Schedule Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Schedule Mentor');
  await seedUser(otherMentorEmail, PASSWORD, 'MENTOR', 'Other Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Schedule Mentee');
  const contexts: APIRequestContext[] = [];
  try {
    const admin = await signedIn(adminEmail);
    contexts.push(admin);

    // A bad agreement is refused before anything is written.
    const bad = await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: mentee.id, durationMonths: 0 } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).code).toBe('invalid_duration');
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: mentee.id } })).toBe(0);

    const created = await admin.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id, durationMonths: 6, expectedMeetingIntervalWeeks: 2 },
    });
    expect(created.status()).toBe(201);
    const relationId = (await created.json()).relation.id as string;
    const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
    expect(row.expectedMeetingIntervalWeeks).toBe(2);
    const months = (row.expectedEndDate!.getTime() - row.startDate.getTime()) / DAY;
    expect(months).toBeGreaterThan(178);
    expect(months).toBeLessThan(186);
    expect(row.durationExtendedCount).toBe(0);

    // A mentor who is not this pair's may not edit it; an admin edit is not an extension.
    const other = await signedIn(otherMentorEmail);
    contexts.push(other);
    expect((await other.put(`/api/mentorship/${relationId}`, { data: { expectedEndDate: '2030-01-01' } })).status()).toBe(403);
    const newEnd = new Date(row.startDate.getTime() + 300 * DAY).toISOString().slice(0, 10);
    expect((await admin.put(`/api/mentorship/${relationId}`, { data: { expectedEndDate: newEnd } })).ok()).toBe(true);
    const edited = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
    expect(edited.expectedEndDate!.toISOString().slice(0, 10)).toBe(newEnd);
    expect(edited.durationExtendedCount).toBe(0);

    // The mentee sees both, read-only, in their locale.
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');
    await gotoSettled(page, '/portal');
    const line = page.getByTestId('portal-relation-schedule');
    await expect(line).toContainText('Ends');
    await expect(line).toContainText('meets every 2 weeks');
  } finally {
    for (const ctx of contexts) await ctx.dispose();
    for (const email of [menteeEmail, mentorEmail, otherMentorEmail, adminEmail]) await cleanupByEmail(email);
  }
});
