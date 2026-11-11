import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Interview panels stay inside the caller's org (#3588). The tenant middleware
// is off in every deployment (and in this project), and `assertSameOrg()` was a
// no-op with it until #3588 — so each panel route scopes its own lookups. An admin of org A
// must not list, open, edit, close or reopen org B's panel, convene one about
// B's candidate, or seat B's people on A's panel.

const PASSWORD = 'PanelScope123!';

test.afterAll(async () => prisma.$disconnect());

test('interview panels: another org\'s panel and people read as missing to an admin', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `IP A ${s}`, slug: `ip-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `IP B ${s}`, slug: `ip-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['ip-a-admin', 'ip-a-mentor', 'ip-a-mentee', 'ip-b-admin', 'ip-b-mentor', 'ip-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bAdmin, bMentor, bMentee] = emails;
  const bTitle = `Foreign Panel ${s}`;
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'IP A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'IP A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'IP A Mentee', orgA.id);
    const adminB = await seedUser(bAdmin, PASSWORD, 'ADMIN', 'IP B Admin', orgB.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'IP B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'IP B Mentee', orgB.id);

    const aPanel = await prisma.interviewPanel.create({
      data: { orgId: orgA.id, subjectId: ae.id, title: `Own Panel ${s}`, createdById: adminA.id, members: { create: [{ userId: am.id }] } },
    });
    const bPanel = await prisma.interviewPanel.create({
      data: { orgId: orgB.id, subjectId: be.id, title: bTitle, createdById: adminB.id, members: { create: [{ userId: bm.id }] } },
    });
    const bClosed = await prisma.interviewPanel.create({
      data: { orgId: orgB.id, subjectId: be.id, title: `${bTitle} closed`, createdById: adminB.id, closedAt: new Date(), members: { create: [{ userId: bm.id }] } },
    });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    // The list: A's own panel (negative control), never B's.
    const list = await ctx.get('/api/interview-panels');
    expect(list.status()).toBe(200);
    const listText = await list.text();
    expect(listText).toContain(aPanel.id);
    expect(listText).not.toContain(bPanel.id);
    expect(listText).not.toContain(bClosed.id);
    expect((await ctx.get(`/api/interview-panels/${aPanel.id}`)).status()).toBe(200);

    // B's panel by id: missing for every verb, and unchanged.
    expect((await ctx.get(`/api/interview-panels/${bPanel.id}`)).status()).toBe(404);
    expect((await ctx.patch(`/api/interview-panels/${bPanel.id}`, { data: { title: 'Renamed across tenants' } })).status()).toBe(404);
    expect((await ctx.post(`/api/interview-panels/${bPanel.id}/close`)).status()).toBe(404);
    expect((await ctx.post(`/api/interview-panels/${bClosed.id}/reopen`)).status()).toBe(404);
    const bAfter = await prisma.interviewPanel.findUniqueOrThrow({ where: { id: bPanel.id } });
    expect(bAfter.title).toBe(bTitle);
    expect(bAfter.closedAt).toBeNull();
    expect((await prisma.interviewPanel.findUniqueOrThrow({ where: { id: bClosed.id } })).closedAt).not.toBeNull();

    // B's people: not a candidate A can convene about, not an interviewer A can seat.
    expect((await ctx.post('/api/interview-panels', { data: { subjectId: be.id, interviewerIds: [am.id] } })).status()).toBe(404);
    expect((await ctx.post('/api/interview-panels', { data: { subjectId: ae.id, interviewerIds: [bm.id] } })).status()).toBe(400);
    expect((await ctx.patch(`/api/interview-panels/${aPanel.id}`, { data: { addInterviewerIds: [bm.id] } })).status()).toBe(400);
    expect(await prisma.interviewPanelMember.count({ where: { userId: bm.id, panel: { orgId: orgA.id } } })).toBe(0);
    expect(await prisma.interviewPanel.count({ where: { subjectId: be.id, orgId: orgA.id } })).toBe(0);
    await ctx.dispose();
  } finally {
    await prisma.interviewPanel.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
