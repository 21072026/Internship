import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * Admin fan-outs follow the program scope (#3485). A notice to "the org's
 * admins" carries names, so it is a read: an ORG_ADMIN hears everything, a
 * PROGRAM_ADMIN only about subjects its grants cover and never about an
 * org-level event. Proved on one of each:
 *   • an org-level notice (a support ticket) reaches the ORG_ADMIN only;
 *   • a relation notice (a re-match request) reaches the PROGRAM_ADMIN whose
 *     grant names the relation's cohort, and not the one granted another cohort.
 * The rule itself is unit-tested in scripts/test/program-scope-rule.test.mjs.
 */

const PASSWORD = 'FanoutScope123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

test('admin fan-outs: org-level notices skip a PROGRAM_ADMIN; relation notices reach only the one whose grant covers it', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Fanout scope ${stamp}`, slug: `fanout-scope-${stamp}` } });
  const emails = ['fs-org', 'fs-prog-a', 'fs-prog-b', 'fs-mentor', 'fs-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [orgEmail, progAEmail, progBEmail, mentorEmail, menteeEmail] = emails;
  const orgAdmin = await seedUser(orgEmail, PASSWORD, 'ADMIN', 'Org Admin', org.id);
  const progA = await seedUser(progAEmail, PASSWORD, 'ADMIN', 'Program Admin A', org.id);
  const progB = await seedUser(progBEmail, PASSWORD, 'ADMIN', 'Program Admin B', org.id);
  await prisma.user.update({ where: { id: orgAdmin.id }, data: { adminLevel: 'ORG_ADMIN' } });
  await prisma.user.updateMany({ where: { id: { in: [progA.id, progB.id] } }, data: { adminLevel: 'PROGRAM_ADMIN' } });
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Fanout Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', `Fanout Mentee ${stamp}`, org.id);
  const cohortA = await prisma.cohort.create({ data: { name: `Fanout A ${stamp}`, orgId: org.id } });
  const cohortB = await prisma.cohort.create({ data: { name: `Fanout B ${stamp}`, orgId: org.id } });
  await prisma.adminScopeGrant.createMany({
    data: [
      { userId: progA.id, orgId: org.id, cohortId: cohortA.id, createdById: orgAdmin.id },
      { userId: progB.id, orgId: org.id, cohortId: cohortB.id, createdById: orgAdmin.id },
    ],
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, cohortId: cohortA.id },
  });
  const notices = (userId: string, types: string[]) => prisma.notification.count({ where: { userId, type: { in: types } } });

  const ctxMentee = await ctxFor(menteeEmail);
  try {
    // Org-level: a support ticket.
    const ticket = await ctxMentee.post('/api/support', { data: { body: 'My dates look wrong.' }, headers: freshIp('fanout-scope support') });
    expect(ticket.ok()).toBe(true);
    const SUPPORT = ['support.new', 'support.newGeneric'];
    await expect.poll(() => notices(orgAdmin.id, SUPPORT), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(await notices(progA.id, SUPPORT)).toBe(0);
    expect(await notices(progB.id, SUPPORT)).toBe(0);

    // Relation-level: a re-match request on the cohort-A relation.
    const rematch = await ctxMentee.post(`/api/mentorship/${relation.id}/rematch`, { data: { reason: 'no_fit' } });
    expect(rematch.status()).toBe(201);
    const REMATCH = ['mentorship_request.rematch', 'mentorship_request.rematchGeneric'];
    await expect.poll(() => notices(orgAdmin.id, REMATCH), { timeout: 10_000 }).toBe(1);
    expect(await notices(progA.id, REMATCH)).toBe(1);
    expect(await notices(progB.id, REMATCH)).toBe(0);
  } finally {
    await ctxMentee.dispose();
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } }).catch(() => {});
    await prisma.supportTicket.deleteMany({ where: { requesterId: mentee.id } }).catch(() => {});
    await prisma.adminScopeGrant.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
