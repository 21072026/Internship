import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * The routes outside /api/projects/** that take a project id (#2627).
 *
 * #2622 scoped /api/projects/** and the /projects/[id] page. These take a
 * `projectId` (or a relation id) too, and with MT_ENFORCE_ISOLATION off the org
 * middleware scopes nothing while every rule answers true for any ADMIN: an
 * instant meeting, a meeting series, a project-bound contributor-terms
 * acceptance, and a note line converted into a task or a goal all reached
 * another tenant's project. Each now answers another tenant's project like a
 * missing one.
 *
 * The project group chat is gated on a ProjectMember row, and ProjectMember has
 * no org — so a membership that crosses tenants (one written before #2622 closed
 * the members route) opened another tenant's room. The test seeds exactly such a
 * row; the room is now refused like any room the caller may not open.
 *
 * Both orgs are INTERNSHIP, so the `projects` capability is on for both and
 * the refusals are the tenant check, not a capability gate.
 */

const PASSWORD = 'CrossSat123!';
const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
const MARK = `XSAT${stamp}`;
const email = (tag: string) => `xsat-${tag}-${stamp}@e2e.local`;

let orgA: { id: string };
let orgB: { id: string };
let users: Record<'aAdmin' | 'aMentor' | 'aMentee' | 'bAdmin' | 'bMentee', { id: string; email: string; fullName: string }>;
let projectA: { id: string };
let relationA: { id: string };
let seriesA: { id: string };
let roomA: { id: string };
let noteB: { id: string };
let noteA: { id: string };

const NOTE_B = [`${MARK} task line`, `${MARK} goal line`].join('\n');

test.beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  orgA = await prisma.organization.create({ data: { name: `XSat A ${stamp}`, slug: `xsat-a-${stamp}`, vertical: 'INTERNSHIP' } });
  orgB = await prisma.organization.create({ data: { name: `XSat B ${stamp}`, slug: `xsat-b-${stamp}`, vertical: 'INTERNSHIP' } });
  const mk = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) => {
    const fullName = `${MARK} ${tag}`;
    const u = await prisma.user.create({
      data: {
        email: email(tag), password: hash, role, orgId, fullName, skills: [], emailVerified: true, isActive: true,
        ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
      },
    });
    return { id: u.id, email: u.email, fullName };
  };
  users = {
    aAdmin: await mk('a-admin', 'ADMIN', orgA.id),
    aMentor: await mk('a-mentor', 'MENTOR', orgA.id),
    aMentee: await mk('a-mentee', 'MENTEE', orgA.id),
    bAdmin: await mk('b-admin', 'ADMIN', orgB.id),
    bMentee: await mk('b-mentee', 'MENTEE', orgB.id),
  };
  projectA = await prisma.project.create({
    data: {
      name: `${MARK} Project A`, ownerType: 'ADMIN', ownerUserId: users.aAdmin.id, orgId: orgA.id,
      isPublic: false, contributorTermsRequired: true,
    },
  });
  await prisma.projectMember.createMany({
    data: [
      { projectId: projectA.id, userId: users.aAdmin.id, role: 'OWNER' },
      { projectId: projectA.id, userId: users.aMentee.id, role: 'MENTEE' },
      // The cross-tenant membership: B's mentee on A's project.
      { projectId: projectA.id, userId: users.bMentee.id, role: 'MENTEE' },
    ],
  });
  relationA = await prisma.mentorshipRelation.create({
    data: { mentorId: users.aMentor.id, menteeId: users.aMentee.id, orgId: orgA.id },
  });
  seriesA = await prisma.meetingSeries.create({
    data: { projectId: projectA.id, title: `${MARK} Weekly`, daysOfWeek: [1], timeOfDay: '09:30', createdById: users.aAdmin.id },
  });
  roomA = await prisma.conversation.create({
    data: {
      type: 'GROUP', projectId: projectA.id,
      participants: { create: [users.aAdmin, users.aMentee, users.bMentee].map((u) => ({ userId: u.id })) },
      messages: { create: { senderId: users.aAdmin.id, body: `${MARK} internal message` } },
    },
  });
  noteB = await prisma.personalNote.create({ data: { userId: users.bAdmin.id, body: NOTE_B } });
  noteA = await prisma.personalNote.create({ data: { userId: users.aAdmin.id, body: `${MARK} own task line` } });
});

test.afterAll(async () => {
  const ids = Object.values(users ?? {}).map((u) => u.id);
  const pid = projectA?.id;
  if (pid) {
    await prisma.meeting.deleteMany({ where: { OR: [{ projectId: pid }, { relationId: relationA?.id }, { createdById: { in: ids } }] } });
    await prisma.meetingSeries.deleteMany({ where: { OR: [{ projectId: pid }, { createdById: { in: ids } }] } });
    await prisma.message.deleteMany({ where: { OR: [{ conversationId: roomA?.id }, { senderId: { in: ids } }] } });
    await prisma.conversationParticipant.deleteMany({ where: { userId: { in: ids } } });
    await prisma.conversation.deleteMany({ where: { projectId: pid } });
    await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.projectTask.deleteMany({ where: { projectId: pid } });
    await prisma.projectMember.deleteMany({ where: { projectId: pid } });
    await prisma.project.deleteMany({ where: { id: pid } });
  }
  if (relationA) {
    await prisma.goal.deleteMany({ where: { relationId: relationA.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relationA.id } });
  }
  await prisma.personalNote.deleteMany({ where: { userId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } } });
});

async function call(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, data, timeout: 120_000 });
  return { status: res.status(), body: await res.text() };
}

// Everything the probes could have written or changed on A's side.
async function footprint() {
  const [meetings, series, tasks, goals, acceptances, messages, notifications, noteBody] = await Promise.all([
    prisma.meeting.count({ where: { OR: [{ projectId: projectA.id }, { relationId: relationA.id }] } }),
    prisma.meetingSeries.findMany({ where: { projectId: projectA.id }, select: { id: true, title: true, active: true } }),
    prisma.projectTask.count({ where: { projectId: projectA.id } }),
    prisma.goal.count({ where: { relationId: relationA.id } }),
    prisma.contributorTermsAcceptance.count({ where: { projectId: projectA.id } }),
    prisma.message.count({ where: { conversationId: roomA.id } }),
    prisma.notification.count({ where: { userId: { in: [users.aAdmin.id, users.aMentor.id, users.aMentee.id] } } }),
    prisma.personalNote.findUniqueOrThrow({ where: { id: noteB.id }, select: { body: true } }),
  ]);
  return { meetings, series, tasks, goals, acceptances, messages, notifications, noteBody: noteBody.body };
}

test("another tenant's admin gets not-found for a project or relation outside the project routes", { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsFreshUser(page, users.bAdmin.email, PASSWORD, '/admin');
  const before = await footprint();

  // The version the terms route would accept, so a refusal below is the tenant
  // check and not a version mismatch.
  const terms = JSON.parse((await call(page, 'GET', '/api/contributor-terms')).body);
  const version = terms?.terms?.version ?? '1';

  const probes: Array<[string, string, unknown?]> = [
    ['POST', '/api/meetings/instant', { title: `${MARK} planted`, projectId: projectA.id }],
    ['POST', '/api/meetings/instant', { title: `${MARK} planted`, relationIds: [relationA.id] }],
    ['GET', `/api/meeting-series?projectId=${projectA.id}`],
    ['POST', '/api/meeting-series', { projectId: projectA.id, title: `${MARK} planted`, daysOfWeek: [2], timeOfDay: '10:00' }],
    ['PUT', '/api/meeting-series', { id: seriesA.id, title: `${MARK} planted` }],
    ['DELETE', '/api/meeting-series', { id: seriesA.id }],
    ['POST', '/api/contributor-terms', { projectId: projectA.id, version }],
    ['POST', `/api/notes/${noteB.id}/convert`, { line: `${MARK} task line`, target: 'PROJECT_TASK', projectId: projectA.id }],
    ['POST', `/api/notes/${noteB.id}/convert`, { line: `${MARK} goal line`, target: 'GOAL', relationId: relationA.id }],
  ];
  for (const [method, url, data] of probes) {
    const r = await call(page, method, url, data);
    expect.soft(r.status, `${method} ${url} ${JSON.stringify(data ?? {})}`).toBe(404);
    expect.soft(r.body, `${method} ${url}`).not.toContain(MARK);
  }
  expect(await footprint()).toEqual(before);
});

test("a cross-tenant project membership does not open another tenant's group chat", async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.bMentee.email, PASSWORD, '/portal');
  const before = await footprint();

  const probes: Array<[string, string, unknown?]> = [
    ['POST', '/api/conversations', { projectId: projectA.id }],
    ['GET', `/api/messages?conversationId=${roomA.id}`],
    ['POST', '/api/messages', { conversationId: roomA.id, body: `${MARK} planted` }],
  ];
  for (const [method, url, data] of probes) {
    const r = await call(page, method, url, data);
    // 403 is what these routes answer for a room that does not exist.
    expect.soft(r.status, `${method} ${url}`).toBe(403);
    expect.soft(r.body, `${method} ${url}`).not.toContain(MARK);
  }
  const missing = await call(page, 'GET', `/api/messages?conversationId=x${stamp}missing`);
  expect((await call(page, 'GET', `/api/messages?conversationId=${roomA.id}`)).body).toBe(missing.body);
  expect(await footprint()).toEqual(before);
});

test("the tenant's own admin and members keep every one of these", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await signInAsFreshUser(page, users.aAdmin.email, PASSWORD, '/admin');
  const instant = await call(page, 'POST', '/api/meetings/instant', { title: `${MARK} own call`, projectId: projectA.id });
  expect(instant.status, instant.body).toBeLessThan(300);
  const list = await call(page, 'GET', `/api/meeting-series?projectId=${projectA.id}`);
  expect(list.status).toBe(200);
  expect(list.body).toContain(`${MARK} Weekly`);
  const convert = await call(page, 'POST', `/api/notes/${noteA.id}/convert`, {
    line: `${MARK} own task line`, target: 'PROJECT_TASK', projectId: projectA.id,
  });
  expect(convert.status, convert.body).toBe(201);

  const ctx = await browser.newContext();
  const menteePage = await ctx.newPage();
  try {
    await signInAsFreshUser(menteePage, users.aMentee.email, PASSWORD, '/portal');
    const read = await call(menteePage, 'GET', `/api/messages?conversationId=${roomA.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toContain(`${MARK} internal message`);
  } finally {
    await ctx.close();
  }
});
