import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';

// #1807: the screening record on a mentor application. With a required-items
// policy, approval is refused server-side (409 naming what is missing) until
// the items are done; the screening never reaches the applicant.
const PASSWORD = 'Screening123!';
const adminEmail = uniqueEmail('scr-admin');
const applicantEmail = uniqueEmail('scr-applicant');
let admin: APIRequestContext;
let appId = '';
let orgId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  orgId = await defaultOrgId();
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Screening Admin');
  appId = (await prisma.mentorApplication.create({ data: { orgId, fullName: 'Screened Applicant', email: applicantEmail, status: 'UNDER_REVIEW' } })).id;
  admin = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await signInViaApi(admin, adminEmail, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  // Put the org's policy back the way the suite found it: none required.
  await admin.put('/api/mentor-applications/screening-policy', { data: { required: [] } });
  await admin.dispose();
  await prisma.invitationToken.deleteMany({ where: { email: applicantEmail } });
  await prisma.mentorApplication.deleteMany({ where: { id: appId } });
  await cleanupByEmail(adminEmail);
  await prisma.$disconnect();
});

test('a required item blocks approval from the server until it is done', async () => {
  const policy = await admin.put('/api/mentor-applications/screening-policy', { data: { required: ['interviewDone', 'referencesChecked'] } });
  expect(await policy.json()).toEqual({ required: ['referencesChecked', 'interviewDone'] });

  // One of two done: still refused, naming the other.
  const tick = await admin.patch(`/api/mentor-applications/${appId}/screening`, {
    data: { item: 'referencesChecked', done: true, referenceName: 'A. Referee', referenceContact: 'referee@example.test', referenceOutcome: 'Positive' },
  });
  expect(tick.ok()).toBeTruthy();
  const stamped = (await tick.json()).screening.screeningChecklist.referencesChecked;
  expect(stamped.done).toBe(true);
  expect(typeof stamped.at).toBe('string');

  const refused = await admin.patch(`/api/mentor-applications/${appId}`, { data: { action: 'approve' } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'screening_incomplete', missing: ['interviewDone'] });
  expect((await prisma.mentorApplication.findUniqueOrThrow({ where: { id: appId } })).status).toBe('UNDER_REVIEW');

  await admin.patch(`/api/mentor-applications/${appId}/screening`, {
    data: { item: 'interviewDone', done: true, interviewAt: '2026-10-28T09:00:00.000Z', interviewNotes: 'Clear, kind, prepared.' },
  });
  const approved = await admin.patch(`/api/mentor-applications/${appId}`, { data: { action: 'approve' } });
  expect(approved.ok(), await approved.text()).toBeTruthy();
  expect((await approved.json()).status).toBe('APPROVED');

  const row = await prisma.mentorApplication.findUniqueOrThrow({ where: { id: appId } });
  expect(row.referenceName).toBe('A. Referee');
  expect(row.screenedById).not.toBeNull();
  // The activity log records which item changed, never the notes or the reference.
  const logs = await prisma.activityLog.findMany({ where: { action: 'mentor_application.screening', targetId: appId } });
  expect(logs.length).toBe(2);
  expect(JSON.stringify(logs)).not.toContain('Referee');
  expect(JSON.stringify(logs)).not.toContain('prepared');
});

test('only an admin may screen', async ({ playwright }, info) => {
  const mentorEmail = uniqueEmail('scr-mentor');
  await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Screening Mentor');
  const ctx = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    expect((await signInViaApi(ctx, mentorEmail, PASSWORD)).ok).toBe(true);
    expect((await ctx.patch(`/api/mentor-applications/${appId}/screening`, { data: { item: 'backgroundOk', done: true } })).status()).toBe(403);
    expect((await ctx.put('/api/mentor-applications/screening-policy', { data: { required: [] } })).status()).toBe(403);
  } finally {
    await ctx.dispose();
    await cleanupByEmail(mentorEmail);
  }
});
