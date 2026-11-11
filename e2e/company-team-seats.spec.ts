import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Company team seats (#1870, docs/company-team-seats.md). The ROUTE refuses an
// INTERVIEWER seat's writes (403 insufficient_seat_role), an INTERVIEWER reads
// only the candidates of the panels it sits on, only an OWNER manages the team,
// the last OWNER cannot be removed or demoted, and inviting past
// Company.quota answers 403 seat_limit_reached with limit and used.

const PW = 'TeamSeats123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = {
  owner: uniqueEmail('ts-owner'),
  recruiter: uniqueEmail('ts-recruiter'),
  interviewer: uniqueEmail('ts-interviewer'),
  menteeA: uniqueEmail('ts-mentee-a'),
  menteeB: uniqueEmail('ts-mentee-b'),
};
const ids: Record<string, string> = {};
let org: { id: string };
const ctx: Record<string, APIRequestContext> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Seats Org ${stamp}`, slug: `seats-${stamp}` }, select: { id: true } });
  // Quota 4: three logins today, so one more invitation fits and the next does not.
  ids.company = (await prisma.company.create({ data: { orgId: org.id, name: `Acme Seats ${stamp}`, quota: 4 } })).id;
  const mk = async (key: keyof typeof emails, role: 'COMPANY' | 'MENTEE') =>
    (ids[key] = (await prisma.user.create({
      data: { email: emails[key], password: hash, role, orgId: org.id, fullName: `Seats ${key}`, skills: [], ...(role === 'COMPANY' ? { companyId: ids.company } : {}) },
    })).id);
  // The owner has NO membership row: the company's first login from before seats, implicit OWNER.
  await mk('owner', 'COMPANY');
  await mk('recruiter', 'COMPANY');
  await mk('interviewer', 'COMPANY');
  await mk('menteeA', 'MENTEE');
  await mk('menteeB', 'MENTEE');
  await prisma.companyMembership.createMany({
    data: [
      { orgId: org.id, companyId: ids.company, userId: ids.recruiter, seatRole: 'RECRUITER' },
      { orgId: org.id, companyId: ids.company, userId: ids.interviewer, seatRole: 'INTERVIEWER' },
    ],
  });
  ids.requisition = (await prisma.requisition.create({ data: { orgId: org.id, companyId: ids.company, title: `Seats role ${stamp}`, status: 'OPEN', openings: 2, requiredSkills: [] } })).id;
  for (const m of ['menteeA', 'menteeB'] as const) {
    ids[`app_${m}`] = (await prisma.application.create({ data: { orgId: org.id, requisitionId: ids.requisition, menteeId: ids[m], companyId: ids.company } })).id;
  }
  // The interviewer sits on mentee A's panel only.
  const panel = await prisma.interviewPanel.create({ data: { orgId: org.id, subjectId: ids.menteeA, title: 'Panel A' } });
  ids.panel = panel.id;
  await prisma.interviewPanelMember.create({ data: { panelId: panel.id, userId: ids.interviewer } });

  const baseURL = info.project.use.baseURL;
  for (const key of ['owner', 'recruiter', 'interviewer'] as const) {
    ctx[key] = await playwright.request.newContext({ baseURL });
    expect((await signInViaApi(ctx[key], emails[key], PW)).ok).toBe(true);
  }
});

test.afterAll(async () => {
  await Promise.all(Object.values(ctx).map((c) => c.dispose()));
  const userIds = Object.values(ids);
  await prisma.auditLog.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: userIds } } }).catch(() => {});
  await prisma.invitationToken.deleteMany({ where: { companyId: ids.company } }).catch(() => {});
  await prisma.interviewPanel.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.application.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.companyMembership.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
  await prisma.$disconnect();
});

test('an INTERVIEWER seat cannot create a requisition or move an application — the route refuses', { tag: '@smoke' }, async () => {
  const create = await ctx.interviewer.post('/api/requisitions', { data: { title: `Nope ${stamp}`, status: 'DRAFT', openings: 1, filled: 0, requiredSkills: [] } });
  expect(create.status()).toBe(403);
  expect((await create.json()).code).toBe('insufficient_seat_role');

  const move = await ctx.interviewer.patch(`/api/applications/${ids.app_menteeA}/stage`, { data: { toStage: 'SCREENING', expectedStage: 'APPLIED' } });
  expect(move.status()).toBe(403);
  expect((await move.json()).code).toBe('insufficient_seat_role');
  expect((await prisma.application.findUniqueOrThrow({ where: { id: ids.app_menteeA } })).stage).toBe('APPLIED');

  // A RECRUITER may.
  const ok = await ctx.recruiter.post('/api/requisitions', { data: { title: `Recruiter draft ${stamp}`, status: 'DRAFT', openings: 1, filled: 0, requiredSkills: [] } });
  expect(ok.status()).toBe(201);
});

test('an INTERVIEWER reads only the candidates of the panels it sits on', { tag: '@smoke' }, async () => {
  const mine = await ctx.interviewer.get(`/api/company/requisitions/${ids.requisition}/applications`);
  expect(mine.status()).toBe(200);
  const seen = JSON.stringify(await mine.json());
  expect(seen).toContain(ids.app_menteeA);
  expect(seen).not.toContain(ids.app_menteeB);

  const all = JSON.stringify(await (await ctx.recruiter.get(`/api/company/requisitions/${ids.requisition}/applications`)).json());
  expect(all).toContain(ids.app_menteeA);
  expect(all).toContain(ids.app_menteeB);
});

test('only an OWNER manages the team or edits the profile', async () => {
  for (const seat of ['recruiter', 'interviewer'] as const) {
    const invite = await ctx[seat].post('/api/company/team', { data: { email: `x-${seat}-${stamp}@acme.example`, seatRole: 'INTERVIEWER' } });
    expect(invite.status()).toBe(403);
    expect((await invite.json()).code).toBe('insufficient_seat_role');
    expect((await ctx[seat].put(`/api/companies/${ids.company}`, { data: { description: 'not mine' } })).status()).toBe(403);
  }
  // Everyone with a seat may see the team; the implicit owner reads as OWNER.
  const team = await (await ctx.interviewer.get('/api/company/team')).json();
  expect(team.members.find((m: { userId: string }) => m.userId === ids.owner).seatRole).toBe('OWNER');
  expect(team.mySeat).toBe('INTERVIEWER');
});

test('the seat limit: Company.quota, answered with limit and used', { tag: '@smoke' }, async () => {
  const first = await ctx.owner.post('/api/company/team', { data: { email: `new-one-${stamp}@acme.example`, seatRole: 'HIRING_MANAGER' } });
  expect(first.status()).toBe(201);
  const body = await first.json();
  expect(JSON.stringify(body)).not.toMatch(/token/i);
  expect(await prisma.invitationToken.findFirst({ where: { email: `new-one-${stamp}@acme.example` } })).toMatchObject({ companyId: ids.company, companySeatRole: 'HIRING_MANAGER', role: 'COMPANY' });

  const second = await ctx.owner.post('/api/company/team', { data: { email: `new-two-${stamp}@acme.example`, seatRole: 'RECRUITER' } });
  expect(second.status()).toBe(403);
  expect(await second.json()).toMatchObject({ code: 'seat_limit_reached', limit: 4, used: 4 });
});

test('the last OWNER cannot be demoted or removed; a removed teammate loses the company', { tag: '@smoke' }, async () => {
  // The owner may not remove itself, and the recruiter cannot act at all.
  expect((await ctx.owner.delete(`/api/company/team/${ids.owner}`)).status()).toBe(400);

  // Promote the recruiter to OWNER, then the original owner may be demoted — but not the other way round once one is left.
  expect((await ctx.owner.patch(`/api/company/team/${ids.recruiter}`, { data: { seatRole: 'OWNER' } })).status()).toBe(200);
  expect((await ctx.recruiter.patch(`/api/company/team/${ids.owner}`, { data: { seatRole: 'RECRUITER' } })).status()).toBe(200);
  const last = await ctx.recruiter.patch(`/api/company/team/${ids.owner}`, { data: { seatRole: 'OWNER' } });
  expect(last.status()).toBe(200);
  // Two owners now; demote the recruiter back, then the remaining single owner is protected.
  expect((await ctx.owner.patch(`/api/company/team/${ids.recruiter}`, { data: { seatRole: 'RECRUITER' } })).status()).toBe(200);
  const demoteLast = await ctx.recruiter.patch(`/api/company/team/${ids.owner}`, { data: { seatRole: 'RECRUITER' } });
  expect(demoteLast.status()).toBe(403); // a RECRUITER seat cannot manage at all any more
  // The single remaining owner cannot demote itself: the company would have none.
  const selfDemote = await ctx.owner.patch(`/api/company/team/${ids.owner}`, { data: { seatRole: 'RECRUITER' } });
  expect(selfDemote.status()).toBe(409);
  expect((await selfDemote.json()).code).toBe('last_owner');
  // The owner removes the interviewer: detached, deactivated, audited.
  expect((await ctx.owner.delete(`/api/company/team/${ids.interviewer}`)).status()).toBe(200);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: ids.interviewer } })).toMatchObject({ companyId: null, isActive: false });
  expect(await prisma.companyMembership.count({ where: { userId: ids.interviewer } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'COMPANY_SEAT_REMOVED', targetId: ids.interviewer } })).toBe(1);
  // Another company's member is a 404.
  expect((await ctx.owner.delete(`/api/company/team/${ids.menteeA}`)).status()).toBe(404);
});
