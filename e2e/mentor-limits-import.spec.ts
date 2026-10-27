import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1808: POST /api/admin/mentors/limits/import — dry run first, per-row report,
// writes only on the confirmed second call; booking columns land on
// MentorBookingPolicy; an unknown address is reported and never created.
const PASSWORD = 'LimitsImport123!';
const emails = {
  admin: uniqueEmail('mli-admin'),
  mentor: uniqueEmail('mli-mentor'),
  mentee: uniqueEmail('mli-mentee'),
  ghost: uniqueEmail('mli-ghost'),
};
const ctx: Record<'admin' | 'mentor', APIRequestContext> = {} as never;
let mentorId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  await seedUser(emails.admin, PASSWORD, 'ADMIN', 'MLI Admin');
  mentorId = (await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'MLI Mentor')).id;
  await prisma.user.update({ where: { id: mentorId }, data: { mentorCapacity: 4 } });
  await seedUser(emails.mentee, PASSWORD, 'MENTEE', 'MLI Mentee');
  for (const role of ['admin', 'mentor'] as const) {
    ctx[role] = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    expect((await signInViaApi(ctx[role], emails[role], PASSWORD)).ok).toBe(true);
  }
});

test.afterAll(async () => {
  await Promise.all(Object.values(ctx).map((c) => c?.dispose()));
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  await prisma.$disconnect();
});

const csv = () =>
  [
    'email,mentorCapacity,selfMatchLimit,acceptingMentees,minNoticeMinutes,maxPerMonth',
    `${emails.mentor.toUpperCase()},6,2,yes,1440,8`,
    `${emails.ghost},3,1,,,`,
    `${emails.mentee},1,,,,`,
    `${emails.mentor},x,,,,`,
  ].join('\n');

test('only an admin may import', async () => {
  const res = await ctx.mentor.post('/api/admin/mentors/limits/import', { data: { text: csv() } });
  expect(res.status()).toBe(403);
});

test('the dry run reports every row and writes nothing', async () => {
  const res = await ctx.admin.post('/api/admin/mentors/limits/import', { data: { text: csv() } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(body.dryRun).toBe(true);
  expect(body.rows).toEqual([
    { row: 1, key: emails.mentor, status: 'UPDATE', changed: ['mentorCapacity', 'selfMatchLimit', 'acceptingMentees', 'minNoticeMinutes', 'maxPerMonth'] },
    { row: 2, key: emails.ghost, status: 'SKIP', reason: 'not_found' },
    { row: 3, key: emails.mentee, status: 'SKIP', reason: 'not_a_mentor' },
    { row: 4, key: emails.mentor, status: 'ERROR', reason: 'mentorCapacity: not_integer' },
  ]);
  const mentor = await prisma.user.findUniqueOrThrow({ where: { id: mentorId }, select: { mentorCapacity: true, selfMatchLimit: true } });
  expect(mentor).toEqual({ mentorCapacity: 4, selfMatchLimit: null });
  expect(await prisma.mentorBookingPolicy.findUnique({ where: { mentorId } })).toBeNull();
});

test('the confirmed call writes User and MentorBookingPolicy, never creates the unknown address', async () => {
  const res = await ctx.admin.post('/api/admin/mentors/limits/import', { data: { text: csv(), apply: true } });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).dryRun).toBe(false);
  const mentor = await prisma.user.findUniqueOrThrow({ where: { id: mentorId }, select: { mentorCapacity: true, selfMatchLimit: true, acceptingMentees: true } });
  expect(mentor).toEqual({ mentorCapacity: 6, selfMatchLimit: 2, acceptingMentees: true });
  const policy = await prisma.mentorBookingPolicy.findUniqueOrThrow({ where: { mentorId } });
  expect({ minNoticeMinutes: policy.minNoticeMinutes, maxPerMonth: policy.maxPerMonth, maxPerWeek: policy.maxPerWeek }).toEqual({ minNoticeMinutes: 1440, maxPerMonth: 8, maxPerWeek: null });
  expect(await prisma.user.count({ where: { email: emails.ghost } })).toBe(0);

  // Re-running the same file changes nothing; a "-" clears.
  const again = await (await ctx.admin.post('/api/admin/mentors/limits/import', { data: { text: csv() } })).json();
  expect(again.rows[0].status).toBe('UNCHANGED');
  await ctx.admin.post('/api/admin/mentors/limits/import', { data: { text: `email,selfMatchLimit\n${emails.mentor},-`, apply: true } });
  expect((await prisma.user.findUniqueOrThrow({ where: { id: mentorId } })).selfMatchLimit).toBeNull();
});

test('an unreadable header refuses the whole file', async () => {
  const res = await ctx.admin.post('/api/admin/mentors/limits/import', { data: { text: `email,minNoticeHours\n${emails.mentor},24` } });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ code: 'unknown_column', column: 'minNoticeHours' });
});
