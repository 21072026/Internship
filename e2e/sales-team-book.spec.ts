import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { writeSetting } from '../src/lib/settingsWrite';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The team's sales book, read-only (src/lib/salesTeamBook.ts, the rule in
// src/lib/salesBookRule.ts): GET /api/sales/team-book lists every record of the
// caller's org for a rep while `salesTeamBookForReps` is on (the default), for
// an admin and the dispatcher always — and never another org's, never the
// contact's e-mail/phone, the deal value or the follow-up. Off, a rep gets the
// same 404 as a route that does not exist; so does a lead.

test.describe.configure({ mode: 'serial' });

const PW = 'SalesTeamBook123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
const emails: string[] = [];
const orgIds: string[] = [];
let stages: string[] = [];

async function org(label: string) {
  const id = (await prisma.organization.create({ data: { name: `TB ${label} ${STAMP}`, slug: `tb-${label}-${STAMP}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const payload = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: payload.map((st) => ({ orgId: id, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color })),
  });
  stages = payload.filter((st) => !st.isTerminal && !st.isOffPath).map((st) => st.key);
  return id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  const email = uniqueEmail(`tb-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `TB ${label} ${STAMP}`, orgId)).id;
  mail[label] = email;
}

async function record(label: string, ownerId: string, orgId: string, stage: string) {
  await person(`lead-${label}`, 'MENTEE', orgId);
  const company = await prisma.company.create({
    data: { orgId, name: `TB Account ${label} ${STAMP}`, contactEmail: `buyer-${label}-${STAMP}@acme.example`, contactPhone: '+49 30 1234567' },
  });
  ids[`rel-${label}`] = (await prisma.mentorshipRelation.create({
    data: {
      orgId, mentorId: ownerId, menteeId: ids[`lead-${label}`], companyId: company.id, pipelineStatus: stage,
      nextActionAt: new Date(Date.now() + 86_400_000), nextActionNote: `secret follow-up ${label}`,
    },
  })).id;
}

async function jar(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, baseURL: string | undefined, label: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const res = await signInViaApi(ctx, mail[label], PW, { host: MARKETING_HOST, headers: freshIp(`tb-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

test.beforeAll(async () => {
  const a = await org('a');
  const b = await org('b');
  ids.orgA = a;
  await person('rep1', 'MENTOR', a);
  await person('rep2', 'MENTOR', a);
  await person('disp', 'MENTOR', a);
  await prisma.user.update({ where: { id: ids.disp }, data: { salesDispatcher: true } });
  await person('admin', 'ADMIN', a);
  await person('foreignRep', 'MENTOR', b);
  await record('r1', ids.rep1, a, stages[0]);
  await record('r2', ids.rep2, a, stages[1]);
  await record('r3', ids.rep2, a, stages[1]);
  await record('f1', ids.foreignRep, b, stages[1]);
});

test.afterAll(async () => {
  const where = { orgId: { in: orgIds } };
  await prisma.setting.deleteMany({ where }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.company.deleteMany({ where }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

const ROW_KEYS = ['companyId', 'companyName', 'daysInStage', 'id', 'lastContactAt', 'leadName', 'ownerAvatarUrl', 'ownerId', 'ownerName', 'pipelineStatus', 'status', 'trialEndsAt'];
const NEVER = /email|phone|value|nextAction|contact(?!At)/i;

test('a rep reads the whole team book of their org — nothing of another org, no contact, value or follow-up', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const ctx = await jar(playwright, baseURL, 'rep1');
  try {
    const res = await ctx.get('/api/sales/team-book');
    expect(res.status()).toBe(200);
    const text = await res.text();
    const book = JSON.parse(text);
    const listed = (book.rows as { id: string }[]).map((r) => r.id);
    expect(listed.sort()).toEqual([ids['rel-r1'], ids['rel-r2'], ids['rel-r3']].sort());
    expect(listed).not.toContain(ids['rel-f1']);
    expect(book.total).toBe(3);
    expect(book.truncated).toBe(false);

    // The row is exactly the published list of keys — and none names a contact,
    // a value or the follow-up; nor do the values (the follow-up note, the e-mail, the phone).
    for (const row of book.rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      for (const key of Object.keys(row)) expect(key).not.toMatch(NEVER);
    }
    expect(text).not.toContain('secret follow-up');
    expect(text).not.toContain('@acme.example');
    expect(text).not.toContain('1234567');
    expect(text).not.toContain(`TB lead-f1 ${STAMP}`);

    const r2 = book.rows.find((r: { id: string }) => r.id === ids['rel-r2']);
    expect(r2).toMatchObject({ leadName: `TB lead-r2 ${STAMP}`, ownerId: ids.rep2, ownerName: `TB rep2 ${STAMP}`, companyName: `TB Account r2 ${STAMP}`, pipelineStatus: stages[1], status: 'ACTIVE' });
    expect(r2.daysInStage).toBe(0);

    // Counts over the whole book, whatever the filters.
    expect(book.byStage).toEqual(expect.arrayContaining([{ stage: stages[1], count: 2 }, { stage: stages[0], count: 1 }]));
    expect(book.byOwner.find((o: { ownerId: string }) => o.ownerId === ids.rep2)).toMatchObject({ count: 2, ownerName: `TB rep2 ${STAMP}` });
    expect(book.byOwner.map((o: { ownerId: string }) => o.ownerId)).not.toContain(ids.foreignRep);

    const narrowed = await (await ctx.get(`/api/sales/team-book?owners=${ids.rep2}&stage=${stages[1]}`)).json();
    expect((narrowed.rows as { id: string }[]).map((r) => r.id).sort()).toEqual([ids['rel-r2'], ids['rel-r3']].sort());
    expect(narrowed.total).toBe(2);
    expect(narrowed.byOwner.length).toBe(book.byOwner.length);
    // Another org's owner id matches nothing — it never widens the read.
    const foreign = await (await ctx.get(`/api/sales/team-book?owners=${ids.foreignRep}`)).json();
    expect(foreign.rows).toEqual([]);
  } finally {
    await ctx.dispose();
  }
});

test('switched off, a rep gets a 404; the admin and the dispatcher still read it; a lead never does', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  await writeSetting('salesTeamBookForReps', 'false', ids.orgA);
  try {
    for (const [label, status] of [['rep1', 404], ['admin', 200], ['disp', 200], ['lead-r1', 404]] as const) {
      const ctx = await jar(playwright, baseURL, label);
      try {
        expect((await ctx.get('/api/sales/team-book')).status(), label).toBe(status);
      } finally {
        await ctx.dispose();
      }
    }
  } finally {
    await writeSetting('salesTeamBookForReps', 'true', ids.orgA);
  }
});

test('the admin switches it from the settings API; it is written to their org only', async ({ playwright, baseURL }) => {
  const ctx = await jar(playwright, baseURL, 'admin');
  try {
    const res = await ctx.put('/api/admin/settings', { data: { salesTeamBookForReps: 'false' } });
    expect(res.status()).toBe(200);
    expect((await prisma.setting.findFirst({ where: { orgId: ids.orgA, key: 'salesTeamBookForReps' } }))?.value).toBe('false');
    expect(await prisma.setting.count({ where: { orgId: null, key: 'salesTeamBookForReps' } })).toBe(0);
    expect((await ctx.put('/api/admin/settings', { data: { salesTeamBookForReps: 'true' } })).status()).toBe(200);
  } finally {
    await ctx.dispose();
  }
});
