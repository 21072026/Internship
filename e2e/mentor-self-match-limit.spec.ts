import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1808: a mentor at their self-match limit disappears from self-selection —
// the directory (for a mentee), the preferred-mentor request and the public
// apply link — but stays assignable by an admin. Capacity is left with room on
// purpose, so the only thing that can close those doors is the new limit.
const PASSWORD = 'SelfMatch123!';

const emails = {
  admin: uniqueEmail('sml-admin'),
  mentor: uniqueEmail('sml-mentor'),
  seat: uniqueEmail('sml-seat'),
  asker: uniqueEmail('sml-asker'),
  applicant: uniqueEmail('sml-applicant'),
};
const ctx: Record<'admin' | 'asker', APIRequestContext> = {} as never;
let mentorId = '';
let seatId = '';
let askerId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  await seedUser(emails.admin, PASSWORD, 'ADMIN', 'SML Admin');
  const mentor = await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'SML Mentor');
  mentorId = mentor.id;
  await prisma.user.update({ where: { id: mentorId }, data: { publicProfile: true, acceptingMentees: true, mentorCapacity: 5, selfMatchLimit: 1 } });
  await prisma.userConsent.create({ data: { userId: mentorId, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() } });

  // One mentee picked this mentor and was approved onto them: the one seat.
  const seat = await seedUser(emails.seat, PASSWORD, 'MENTEE', 'SML Seat');
  seatId = seat.id;
  await prisma.mentorshipRequest.create({ data: { menteeId: seatId, preferredMentorId: mentorId, status: 'APPROVED' } });
  await prisma.mentorshipRelation.create({ data: { mentorId, menteeId: seatId } });

  // A second mentee, onboarded (#591), who would like the same mentor.
  const asker = await seedUser(emails.asker, PASSWORD, 'MENTEE', 'SML Asker');
  askerId = asker.id;
  await prisma.user.update({ where: { id: askerId }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({ data: { userId: askerId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf } });

  const baseURL = info.project.use.baseURL;
  for (const role of ['admin', 'asker'] as const) {
    ctx[role] = await playwright.request.newContext({ baseURL });
    expect((await signInViaApi(ctx[role], emails[role], PASSWORD)).ok).toBe(true);
  }
});

test.afterAll(async () => {
  await Promise.all(Object.values(ctx).map((c) => c?.dispose()));
  for (const e of [emails.applicant, emails.asker, emails.seat, emails.mentor, emails.admin]) await cleanupByEmail(e);
  await prisma.$disconnect();
});

test('the directory shows a mentee self_match_full, an admin the capacity answer', async () => {
  const asMentee = await (await ctx.asker.get(`/api/mentors?mentorId=${mentorId}`)).json();
  expect(asMentee.mentors[0].availabilityStatus).toBe('self_match_full');
  const filtered = await (await ctx.asker.get(`/api/mentors?accepting=1&mentorId=${mentorId}`)).json();
  expect(filtered.mentors).toHaveLength(0);

  const asAdmin = await (await ctx.admin.get(`/api/mentors?mentorId=${mentorId}`)).json();
  expect(asAdmin.mentors[0].availabilityStatus).toBe('available');
});

test('self-selection is refused on both paths', async ({ request }) => {
  const res = await ctx.asker.post('/api/mentorship-requests', { data: { preferredMentorId: mentorId } });
  expect(res.status()).toBe(409);
  expect((await res.json()).code).toBe('mentor_self_match_full');
  expect(await prisma.mentorshipRequest.count({ where: { menteeId: askerId } })).toBe(0);

  expect((await (await request.get(`/api/apply?mentorId=${mentorId}`)).json()).accepting).toBe(false);
  const apply = await request.post('/api/apply', { data: { mentorId, fullName: 'SML Applicant', email: emails.applicant } });
  expect(apply.status()).toBe(409);
  expect((await apply.json()).code).toBe('mentor_full');
  expect(await prisma.user.findFirst({ where: { email: emails.applicant } })).toBeNull();
});

test('an admin can still assign the mentor', async () => {
  const res = await ctx.admin.post('/api/mentorship', { data: { mentorId, menteeId: askerId } });
  expect(res.ok(), await res.text()).toBeTruthy();
  expect(await prisma.mentorshipRelation.count({ where: { mentorId, menteeId: askerId, status: 'ACTIVE' } })).toBe(1);
});

test('raising the limit reopens self-selection', async ({ request }) => {
  await prisma.user.update({ where: { id: mentorId }, data: { selfMatchLimit: 2 } });
  expect((await (await request.get(`/api/apply?mentorId=${mentorId}`)).json()).accepting).toBe(true);
});
