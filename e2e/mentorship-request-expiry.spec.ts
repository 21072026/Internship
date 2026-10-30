import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1775 — a mentorship request nobody answers: one nudge on day 7, expiry on
// day 14 that frees the mentee, and an admin's cancellation with a reason the
// mentee actually receives.
const PASSWORD = 'Expiry123!x';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;

const emails = { mentee: uniqueEmail('rx-mentee'), mentor: uniqueEmail('rx-mentor') };
const ctx: Record<'admin' | 'mentee', APIRequestContext> = {} as never;
let menteeId = '';
let mentorId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const mentor = await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'RX Mentor');
  mentorId = mentor.id;
  const mentee = await seedUser(emails.mentee, PASSWORD, 'MENTEE', 'RX Mentee');
  menteeId = mentee.id;
  // Onboarded (#591): profile + CV, or the request route refuses first.
  await prisma.user.update({ where: { id: menteeId }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({ data: { userId: menteeId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf } });

  const baseURL = info.project.use.baseURL;
  ctx.admin = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(ctx.admin, ADMIN_EMAIL, ADMIN_PASSWORD)).ok).toBe(true);
  ctx.mentee = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(ctx.mentee, emails.mentee, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all(Object.values(ctx).map((c) => c?.dispose()));
  await prisma.notification.deleteMany({ where: { userId: { in: [menteeId, mentorId] } } }).catch(() => {});
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  await prisma.$disconnect();
});

/** Lets the next request through the route's one-per-hour rate limit. */
async function ageRequests(days: number) {
  const rows = await prisma.mentorshipRequest.findMany({ where: { menteeId }, select: { id: true } });
  for (const r of rows) {
    await prisma.mentorshipRequest.update({ where: { id: r.id }, data: { createdAt: new Date(Date.now() - days * DAY) } });
  }
}

test('a request carries a 14-day expiry; an admin cancels it with a reason the mentee receives', async () => {
  const created = await ctx.mentee.post('/api/mentorship-requests', { data: { message: 'Hello' } });
  expect(created.status()).toBe(201);
  const row = await prisma.mentorshipRequest.findFirstOrThrow({ where: { menteeId, status: 'PENDING' } });
  expect(Math.abs(row.expiresAt!.getTime() - (row.createdAt.getTime() + 14 * DAY))).toBeLessThan(60 * 1000);

  // Still blocking: a second request is refused while this one is live.
  await ageRequests(2);
  expect((await ctx.mentee.post('/api/mentorship-requests', { data: {} })).status()).toBe(409);

  // A non-admin cannot cancel — checked by the route, not by a hidden button.
  expect((await ctx.mentee.put('/api/admin/mentorship-requests', { data: { requestId: row.id, action: 'cancel', reason: 'x' } })).ok()).toBe(false);
  // No reason, no cancellation.
  const noReason = await ctx.admin.put('/api/admin/mentorship-requests', { data: { requestId: row.id, action: 'cancel' } });
  expect(noReason.status()).toBe(400);
  expect((await noReason.json()).code).toBe('reason_required');

  const cancelled = await ctx.admin.put('/api/admin/mentorship-requests', {
    data: { requestId: row.id, action: 'cancel', reason: 'The programme is full this term.' },
  });
  expect(cancelled.status()).toBe(200);
  expect(await prisma.mentorshipRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    status: 'CANCELLED',
    cancelReason: 'The programme is full this term.',
  });
  const note = await prisma.notification.findFirst({ where: { userId: menteeId, type: 'mentorship_request.cancelled' } });
  expect(note?.params).toMatchObject({ reason: 'The programme is full this term.' });
  const mine = await (await ctx.mentee.get('/api/mentorship-requests')).json();
  expect(mine.requests[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'The programme is full this term.' });
  // Cancelling twice is a conflict, not a second notice.
  expect((await ctx.admin.put('/api/admin/mentorship-requests', { data: { requestId: row.id, action: 'cancel', reason: 'again' } })).status()).toBe(409);
});

test('past its expiry a request no longer blocks; the sweep expires it and tells the mentee', async () => {
  await ageRequests(2);
  expect((await ctx.mentee.post('/api/mentorship-requests', { data: {} })).status()).toBe(201);
  const open = await prisma.mentorshipRequest.findFirstOrThrow({ where: { menteeId, status: 'PENDING' } });
  await prisma.mentorshipRequest.update({
    where: { id: open.id },
    data: { createdAt: new Date(Date.now() - 15 * DAY), expiresAt: new Date(Date.now() - DAY), nudgeSentAt: new Date(Date.now() - 8 * DAY) },
  });

  // Unblocked at once — the mentee does not wait for the 09:00 sweep.
  expect((await ctx.mentee.post('/api/mentorship-requests', { data: {} })).status()).toBe(201);

  const swept = await ctx.admin.get('/api/cron?job=mentorship-requests');
  expect(swept.ok()).toBeTruthy();
  expect((await prisma.mentorshipRequest.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('EXPIRED');
  expect(await prisma.notification.count({ where: { userId: menteeId, type: 'mentorship_request.expired' } })).toBe(1);
  // A second run finds nothing new.
  await ctx.admin.get('/api/cron?job=mentorship-requests');
  expect(await prisma.notification.count({ where: { userId: menteeId, type: 'mentorship_request.expired' } })).toBe(1);
});

test('on day 7 the named mentor is nudged exactly once', async () => {
  const req = await prisma.mentorshipRequest.create({
    data: { menteeId, preferredMentorId: mentorId, createdAt: new Date(Date.now() - 8 * DAY), expiresAt: new Date(Date.now() + 6 * DAY) },
  });
  // The active mentor must be a MENTOR in good standing.
  await prisma.user.update({ where: { id: mentorId }, data: { isActive: true } });
  try {
    await ctx.admin.get('/api/cron?job=mentorship-requests');
    await ctx.admin.get('/api/cron?job=mentorship-requests');
    expect(await prisma.notification.count({ where: { userId: mentorId, type: 'mentorship_request.nudge' } })).toBe(1);
    const after = await prisma.mentorshipRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('PENDING');
    expect(after.nudgeSentAt).not.toBeNull();
  } finally {
    await prisma.mentorshipRequest.delete({ where: { id: req.id } }).catch(() => {});
  }
});
