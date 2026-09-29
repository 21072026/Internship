import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * Rows that hang off a MentorshipRelation or a user, across two tenants (#2542).
 *
 * InteractionLog, RelationNote, MentorQuestion, MeetingRequest, Goal,
 * Evaluation, StatusChange and ProjectTask carry no orgId of their own, so the
 * tenant middleware cannot scope them — and with MT_ENFORCE_ISOLATION off (the
 * production state, and this project's server) it scopes nothing at all. Every
 * one of these routes let an ADMIN of one org read or write another org's rows
 * by id. The routes now resolve the parent's org and answer another tenant's
 * row exactly like a missing one.
 *
 * Both orgs are INTERNSHIP on purpose: a MARKETING admin is already stopped by
 * the capability gate on some of these writes, which would hide the org check
 * this spec is about. Every seeded actor has an explicit orgId — the rest of
 * the suite's seedUser() users are org-less, the single-tenant case, and that
 * one is covered by the existing specs of these routes.
 */

const PASSWORD = 'CrossTenant123!';
const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
const MARK = `XREL${stamp}`;
const email = (tag: string) => `xrel-${tag}-${stamp}@e2e.local`;

type Seeded = Awaited<ReturnType<typeof seedChildren>>;
let orgA: { id: string };
let orgB: { id: string };
let users: Record<'aMentor' | 'aMentee' | 'aAdmin' | 'bAdmin', { id: string; email: string }>;
let relationId: string;
let projectId: string;
let attacked: Seeded;
let owned: Seeded;

async function seedChildren(tag: string) {
  const t = `${MARK}-${tag}`;
  const base = { relationId };
  return {
    interaction: await prisma.interactionLog.create({ data: { ...base, date: new Date(), notes: `${t} note`, type: 'Meeting' } }),
    note: await prisma.relationNote.create({ data: { ...base, authorId: users.aMentor.id, body: `${t} private` } }),
    question: await prisma.mentorQuestion.create({ data: { ...base, askedById: users.aMentee.id, question: `${t} q` } }),
    request: await prisma.meetingRequest.create({
      data: { ...base, requestedById: users.aMentee.id, topic: `${t} mr`, proposedAt: new Date(Date.now() + 86_400_000) },
    }),
    goal: await prisma.goal.create({ data: { ...base, title: `${t} goal` } }),
    evaluation: await prisma.evaluation.create({
      data: { ...base, authorId: users.aMentor.id, comment: `${t} ev`, submittedAt: new Date() },
    }),
    statusChange: await prisma.statusChange.create({
      data: { ...base, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', changedById: users.aMentor.id },
    }),
    todo: await prisma.projectTask.create({ data: { title: `${t} todo`, assigneeId: users.aMentee.id, createdById: users.aMentor.id } }),
    projectTodo: await prisma.projectTask.create({ data: { title: `${t} ptodo`, projectId } }),
  };
}

test.beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  orgA = await prisma.organization.create({ data: { name: `XRel A ${stamp}`, slug: `xrel-a-${stamp}`, vertical: 'INTERNSHIP' } });
  orgB = await prisma.organization.create({ data: { name: `XRel B ${stamp}`, slug: `xrel-b-${stamp}`, vertical: 'INTERNSHIP' } });
  const mk = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) => {
    const u = await prisma.user.create({
      data: {
        email: email(tag), password: hash, role, orgId, fullName: `${tag} ${stamp}`, skills: [], emailVerified: true, isActive: true,
        ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
      },
    });
    return { id: u.id, email: u.email };
  };
  users = {
    aMentor: await mk('a-mentor', 'MENTOR', orgA.id),
    aMentee: await mk('a-mentee', 'MENTEE', orgA.id),
    aAdmin: await mk('a-admin', 'ADMIN', orgA.id),
    bAdmin: await mk('b-admin', 'ADMIN', orgB.id),
  };
  relationId = (await prisma.mentorshipRelation.create({
    data: { mentorId: users.aMentor.id, menteeId: users.aMentee.id, orgId: orgA.id },
  })).id;
  projectId = (await prisma.project.create({
    data: { name: `${MARK} project`, ownerType: 'MENTOR', ownerUserId: users.aMentor.id, orgId: orgA.id },
  })).id;
  attacked = await seedChildren('atk');
  owned = await seedChildren('own');
});

test.afterAll(async () => {
  const ids = Object.values(users ?? {}).map((u) => u.id);
  await prisma.projectTask.deleteMany({ where: { OR: [{ projectId }, { assigneeId: { in: ids } }] } });
  await prisma.meeting.deleteMany({ where: { relationId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  // Cascades the relation's children (logs, notes, questions, requests, goals,
  // evaluations, stage history).
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } } });
});

async function call(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, data, timeout: 120_000 });
  return { status: res.status(), body: await res.text() };
}

test('another tenant\'s admin gets not-found for every relation child, and changes nothing', async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsFreshUser(page, users.bAdmin.email, PASSWORD, '/admin');
  const a = attacked;

  // Lists: the other tenant's rows are simply absent.
  for (const url of ['/api/interactions', `/api/interactions?relationId=${relationId}`]) {
    const r = await call(page, 'GET', url);
    expect(r.status, url).toBe(200);
    expect(r.body, url).not.toContain(MARK);
  }

  // A relationId the caller's tenant does not own answers like a missing one.
  const refused: Array<[string, string, unknown?]> = [
    ['GET', `/api/relation-notes?relationId=${relationId}`],
    ['POST', '/api/relation-notes', { relationId, body: 'planted' }],
    ['GET', `/api/questions?relationId=${relationId}`],
    ['POST', '/api/questions', { relationId, question: 'planted' }],
    ['GET', `/api/meeting-requests?relationId=${relationId}`],
    ['POST', '/api/meeting-requests', { relationId, topic: 'planted', proposedAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }],
    ['POST', '/api/interactions/summary', { relationId }],
    ['POST', '/api/interactions', { relationId, date: new Date().toISOString(), notes: 'planted', type: 'Meeting' }],
    ['GET', `/api/goals?relationId=${relationId}`],
    ['POST', '/api/goals', { relationId, title: 'planted' }],
    ['GET', `/api/evaluations?relationId=${relationId}`],
    ['POST', '/api/evaluations', { relationId, scores: { zzz: 3 } }],
    ['POST', '/api/status-changes', {
      relationId, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    }],
    ['GET', `/api/todos?userId=${users.aMentee.id}`],
    ['POST', '/api/todos', { title: 'planted', assigneeId: users.aMentee.id }],
  ];
  for (const [method, url, data] of refused) {
    const r = await call(page, method, url, data);
    expect([403, 404], `${method} ${url} → ${r.body}`).toContain(r.status);
    expect(r.body, `${method} ${url}`).not.toContain(MARK);
    // Reaching the AI gate (consent/quota/not configured) would mean the relation was accepted.
    expect(r.body, `${method} ${url}`).not.toMatch(/consent_required|not_configured|quota_exceeded|Unknown criteria/);
  }

  // One row by id: 404, never 403 — and before any write.
  const byId: Array<[string, string, unknown?]> = [
    ['GET', `/api/interactions/${a.interaction.id}`],
    ['PUT', `/api/interactions/${a.interaction.id}`, { notes: 'rewritten' }],
    ['PATCH', `/api/relation-notes/${a.note.id}`, { body: 'rewritten' }],
    ['PATCH', `/api/questions/${a.question.id}`, { answer: 'answered' }],
    ['PATCH', `/api/meeting-requests/${a.request.id}`, { action: 'decline' }],
    ['PATCH', `/api/goals/${a.goal.id}`, { title: 'rewritten' }],
    ['PATCH', `/api/evaluations/${a.evaluation.id}`, { comment: 'rewritten' }],
    ['PATCH', `/api/project-tasks/${a.todo.id}`, { done: true }],
    ['PATCH', `/api/project-tasks/${a.projectTodo.id}`, { done: true }],
    ['DELETE', `/api/relation-notes/${a.note.id}`],
    ['DELETE', `/api/goals/${a.goal.id}`],
    ['DELETE', `/api/evaluations/${a.evaluation.id}`],
    ['DELETE', `/api/status-changes/${a.statusChange.id}`],
    ['DELETE', `/api/project-tasks/${a.todo.id}`],
    ['DELETE', `/api/project-tasks/${a.projectTodo.id}`],
    ['DELETE', `/api/interactions/${a.interaction.id}`],
  ];
  for (const [method, url, data] of byId) {
    const r = await call(page, method, url, data);
    expect(r.status, `${method} ${url} → ${r.body}`).toBe(404);
    expect(r.body, `${method} ${url}`).not.toContain(MARK);
  }

  // Nothing of org A's moved.
  expect((await prisma.interactionLog.findUnique({ where: { id: a.interaction.id } }))?.notes).toBe(a.interaction.notes);
  expect((await prisma.relationNote.findUnique({ where: { id: a.note.id } }))?.body).toBe(a.note.body);
  expect((await prisma.mentorQuestion.findUnique({ where: { id: a.question.id } }))?.answer).toBeNull();
  expect((await prisma.meetingRequest.findUnique({ where: { id: a.request.id } }))?.status).toBe('PENDING');
  expect((await prisma.goal.findUnique({ where: { id: a.goal.id } }))?.title).toBe(a.goal.title);
  expect((await prisma.evaluation.findUnique({ where: { id: a.evaluation.id } }))?.comment).toBe(a.evaluation.comment);
  expect(await prisma.statusChange.findUnique({ where: { id: a.statusChange.id } })).not.toBeNull();
  expect((await prisma.projectTask.findUnique({ where: { id: a.todo.id } }))?.done).toBe(false);
  expect((await prisma.projectTask.findUnique({ where: { id: a.projectTodo.id } }))?.done).toBe(false);
  expect(await prisma.interactionLog.count({ where: { relationId, notes: 'planted' } })).toBe(0);
  expect(await prisma.relationNote.count({ where: { relationId, body: 'planted' } })).toBe(0);
  expect(await prisma.mentorQuestion.count({ where: { relationId, question: 'planted' } })).toBe(0);
  expect(await prisma.meetingRequest.count({ where: { relationId, topic: 'planted' } })).toBe(0);
  expect(await prisma.goal.count({ where: { relationId, title: 'planted' } })).toBe(0);
  expect(await prisma.projectTask.count({ where: { assigneeId: users.aMentee.id, title: 'planted' } })).toBe(0);
});

test('the relation\'s own tenant admin still reads and writes every relation child', async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsFreshUser(page, users.aAdmin.email, PASSWORD, '/admin');
  const o = owned;

  for (const url of [
    '/api/interactions',
    `/api/interactions?relationId=${relationId}`,
    `/api/interactions/${o.interaction.id}`,
    `/api/relation-notes?relationId=${relationId}`,
    `/api/questions?relationId=${relationId}`,
    `/api/meeting-requests?relationId=${relationId}`,
    `/api/goals?relationId=${relationId}`,
    `/api/evaluations?relationId=${relationId}`,
    `/api/todos?userId=${users.aMentee.id}`,
  ]) {
    const r = await call(page, 'GET', url);
    expect(r.status, url).toBe(200);
    expect(r.body, url).toContain(MARK);
  }

  // The relation-level summary gets as far as the AI gate (no consent seeded).
  const summary = await call(page, 'POST', '/api/interactions/summary', { relationId });
  expect(summary.body).toMatch(/consent_required|not_configured|quota_exceeded|summary/);

  const writes: Array<[string, string, unknown?]> = [
    ['POST', '/api/interactions', { relationId, date: new Date().toISOString(), notes: 'own-planted', type: 'Meeting' }],
    ['PUT', `/api/interactions/${o.interaction.id}`, { notes: 'rewritten' }],
    ['POST', '/api/relation-notes', { relationId, body: 'own-planted' }],
    ['PATCH', `/api/relation-notes/${o.note.id}`, { body: 'rewritten' }],
    ['POST', '/api/questions', { relationId, question: 'own-planted' }],
    ['PATCH', `/api/questions/${o.question.id}`, { answer: 'answered' }],
    ['POST', '/api/meeting-requests', { relationId, topic: 'own-planted', proposedAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }],
    ['PATCH', `/api/meeting-requests/${o.request.id}`, { action: 'decline' }],
    ['POST', '/api/goals', { relationId, title: 'own-planted' }],
    ['PATCH', `/api/goals/${o.goal.id}`, { title: 'rewritten' }],
    ['PATCH', `/api/evaluations/${o.evaluation.id}`, { comment: 'rewritten' }],
    ['POST', '/api/status-changes', {
      relationId, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    }],
    ['POST', '/api/todos', { title: 'own-planted', assigneeId: users.aMentee.id }],
    ['PATCH', `/api/project-tasks/${o.todo.id}`, { done: true }],
    ['PATCH', `/api/project-tasks/${o.projectTodo.id}`, { done: true }],
    ['DELETE', `/api/relation-notes/${o.note.id}`],
    ['DELETE', `/api/goals/${o.goal.id}`],
    ['DELETE', `/api/evaluations/${o.evaluation.id}`],
    ['DELETE', `/api/status-changes/${o.statusChange.id}`],
    ['DELETE', `/api/project-tasks/${o.todo.id}`],
    ['DELETE', `/api/project-tasks/${o.projectTodo.id}`],
    ['DELETE', `/api/interactions/${o.interaction.id}`],
  ];
  for (const [method, url, data] of writes) {
    const r = await call(page, method, url, data);
    expect(r.status, `${method} ${url} → ${r.body}`).toBeGreaterThanOrEqual(200);
    expect(r.status, `${method} ${url} → ${r.body}`).toBeLessThan(300);
  }
  expect(await prisma.interactionLog.findUnique({ where: { id: o.interaction.id } })).toBeNull();
  expect(await prisma.goal.findUnique({ where: { id: o.goal.id } })).toBeNull();
  expect((await prisma.meetingRequest.findUnique({ where: { id: o.request.id } }))?.status).toBe('DECLINED');
});
