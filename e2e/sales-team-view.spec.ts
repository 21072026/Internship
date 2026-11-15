import crypto from 'crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { writeSetting } from '../src/lib/settingsWrite';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The team view (src/lib/salesBookRule.ts): the org is closed in on itself, so
// while `salesTeamBookForReps` is on (the default) every seller READS every
// record of it — the board's "Team" toggle (GET /api/sales/team-book), and a
// colleague's lead page and account open read-only: a banner names the owner
// with a link to message them, no editor renders, and the owner's own data —
// the contact's e-mail and phone, the follow-up, the deal value — is not shown.
// WRITING stays the owner's, the dispatcher's and an admin's
// (salesBookWriteAllowed): every write route on a colleague's record answers
// 403/404 and changes nothing. Off, a colleague's record is a 404 again.
// Another org's record is 404 for read and write either way.

test.describe.configure({ mode: 'serial' });

const PW = 'SalesTeam123!';
let orgA = '';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
const emails: string[] = [];
const orgIds: string[] = [];
let stages: string[] = [];

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  const email = uniqueEmail(`team-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `Team ${label} ${STAMP}`, orgId)).id;
  mail[label] = email;
}

async function org(label: string) {
  const id = (await prisma.organization.create({ data: { name: `Team ${label} ${STAMP}`, slug: `team-${label}-${STAMP}`, vertical: 'MARKETING' } })).id;
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

async function record(label: string, ownerId: string, orgId: string) {
  await person(`lead-${label}`, 'MENTEE', orgId);
  const company = await prisma.company.create({ data: { orgId, name: `Team Account ${label} ${STAMP}`, contactEmail: `buyer-${label}-${STAMP}@acme.example`, contactPhone: '+49 30 1234567' } });
  ids[`co-${label}`] = company.id;
  ids[`rel-${label}`] = (await prisma.mentorshipRelation.create({
    data: {
      orgId, mentorId: ownerId, menteeId: ids[`lead-${label}`], companyId: company.id, pipelineStatus: stages[1],
      nextActionAt: new Date(Date.now() + 3 * 86_400_000), nextActionNote: `owner's note ${label}`,
    },
  })).id;
}

async function jar(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, baseURL: string | undefined, label: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const res = await signInViaApi(ctx, mail[label], PW, { host: MARKETING_HOST, headers: freshIp(`team-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

async function signIn(page: Page, label: string) {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail[label], PW, '/sales');
}

test.beforeAll(async () => {
  const a = await org('a');
  orgA = a;
  const b = await org('b');
  await person('rep1', 'MENTOR', a);
  await person('rep2', 'MENTOR', a);
  await person('disp', 'MENTOR', a);
  await prisma.user.update({ where: { id: ids.disp }, data: { salesDispatcher: true } });
  await person('foreignRep', 'MENTOR', b);
  await record('r1', ids.rep1, a);
  await record('r2', ids.rep2, a);
  await record('f1', ids.foreignRep, b);
});

test.afterAll(async () => {
  const where = { orgId: { in: orgIds } };
  await prisma.interactionLog.deleteMany({ where: { relation: where } }).catch(() => {});
  await prisma.meeting.deleteMany({ where: { OR: [{ relation: where }, { title: 'Not mine', createdById: { in: Object.values(ids) } }] } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.setting.deleteMany({ where }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.company.deleteMany({ where }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

/** Every write a sales record has, aimed at `rel` (the PR body lists the route audit). */
// `dropped`: POST /api/meetings takes a LIST of relation ids and drops one the
// caller may not schedule on exactly like a missing one (the WHERE carries
// `mentorId = self`); it answers for what remains, so the proof is the snapshot —
// no Meeting row lands on the record.
function writes(label: string): { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; data?: Record<string, unknown>; dropped?: true }[] {
  const id = ids[`rel-${label}`];
  return [
    { method: 'PUT', path: `/api/mentorship/${id}`, data: { pipelineStatus: stages[2] } },
    { method: 'PUT', path: `/api/mentorship/${id}`, data: { nextActionAt: new Date(Date.now() + 86_400_000).toISOString(), nextActionNote: 'take over' } },
    { method: 'PATCH', path: `/api/mentorship/${id}/trial`, data: { trialEndsAt: '2027-01-31' } },
    { method: 'PATCH', path: `/api/mentorship/${id}/contract-end`, data: { contractEndsAt: '2027-06-30' } },
    { method: 'PUT', path: `/api/mentorship/${id}/value`, data: { valueMinor: 99_900, currency: 'EUR' } },
    { method: 'POST', path: `/api/mentorship/${id}/win-back`, data: { toStage: stages[0] } },
    { method: 'POST', path: `/api/mentorship/${id}/lifecycle`, data: { to: 'COMPLETED' } },
    { method: 'POST', path: `/api/mentorship/${id}/next-step`, data: {} },
    { method: 'POST', path: `/api/sales/leads/${id}/handoff`, data: { toUserId: ids.disp, action: 'call' } },
    { method: 'PATCH', path: `/api/sales/leads/${id}/contact`, data: { name: 'Taken Over', email: `taken-${STAMP}@acme.example` } },
    { method: 'POST', path: '/api/interactions', data: { relationId: id, date: new Date().toISOString(), type: 'Call', notes: 'not mine' } },
    { method: 'POST', path: '/api/meetings', data: { relationIds: [id], title: 'Not mine', scheduledAt: '2027-01-15T10:00:00.000Z', meetLink: '' }, dropped: true },
  ];
}

async function snapshot(label: string) {
  const id = ids[`rel-${label}`];
  const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id } });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: ids[`co-${label}`] }, select: { contactName: true, contactEmail: true } });
  return {
    rel: { mentorId: rel.mentorId, pipelineStatus: rel.pipelineStatus, status: rel.status, nextActionNote: rel.nextActionNote, trialEndsAt: rel.trialEndsAt, contractEndsAt: rel.contractEndsAt },
    company,
    interactions: await prisma.interactionLog.count({ where: { relationId: id } }),
    meetings: await prisma.meeting.count({ where: { relationId: id } }),
  };
}

// No editor, and none of the owner's own data (the follow-up, the value, the contact's e-mail and phone).
const NOT_ON_A_COLLEAGUES_PAGE = [
  'follow-up-panel', 'follow-up-add', 'follow-up-edit', 'follow-up-complete', 'deal-value-panel', 'deal-value-input',
  'sales-lead-handoff', 'sales-lead-log-interaction', 'sales-lead-contact-edit', 'sales-lead-email', 'sales-lead-phone',
  'sales-lead-phone-link', 'sales-lead-plan-meeting',
];

test('a rep reads a colleague’s record read-only; every write on it is refused; another org’s is a 404', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  test.slow();
  await signIn(page, 'rep1');

  // The colleague's page: 200, the banner names the owner, no editor renders.
  await gotoSettled(page, `/sales/leads/${ids['rel-r2']}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Team lead-r2 ${STAMP}`);
  await expect(page.getByTestId('sales-lead-readonly')).toContainText(`Team rep2 ${STAMP}`);
  await expect(page.getByTestId('sales-lead-owner')).toContainText(`Team rep2 ${STAMP}`);
  await expect(page.getByTestId('sales-lead-stage')).toBeVisible();
  await expect(page.getByTestId('sales-lead-message-owner')).toHaveAttribute('href', `/messages?to=${ids.rep2}`);
  await page.waitForLoadState('networkidle');
  for (const testId of NOT_ON_A_COLLEAGUES_PAGE) await expect(page.getByTestId(testId), testId).toHaveCount(0);
  const body = await page.locator('body').innerText();
  for (const secret of ['+49 30 1234567', `buyer-r2-${STAMP}@acme.example`, "owner's note r2"]) expect(body, secret).not.toContain(secret);

  // Their own page: no banner, the editors are there.
  await gotoSettled(page, `/sales/leads/${ids['rel-r1']}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Team lead-r1 ${STAMP}`);
  await expect(page.getByTestId('follow-up-add')).toBeVisible();
  await expect(page.getByTestId('sales-lead-readonly')).toHaveCount(0);

  // The colleague's account opens too (read-only, no editor on the sales view).
  await gotoSettled(page, `/sales/accounts/${ids['co-r2']}`);
  await expect(page.getByTestId('company-detail-name')).toHaveText(`Team Account r2 ${STAMP}`);

  // Every write on the colleague's record: 403/404, nothing changed.
  const ctx = await jar(playwright, baseURL, 'rep1');
  try {
    const before = await snapshot('r2');
    for (const w of writes('r2')) {
      const res = await ctx.fetch(w.path, { method: w.method, data: w.data });
      expect(w.dropped ? [200, 201, 403, 404] : [403, 404], `${w.method} ${w.path} ${JSON.stringify(w.data)} → ${res.status()}`).toContain(res.status());
    }
    expect(await snapshot('r2')).toEqual(before);

    // Another org's record: 404 for the page, 404 (or 403 before the lookup) for every write.
    expect((await ctx.get(`/sales/leads/${ids['rel-f1']}`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await ctx.get(`/sales/accounts/${ids['co-f1']}`, { maxRedirects: 0 })).status()).toBe(404);
    const team = ((await (await ctx.get('/api/mentorship?surface=sales&view=team')).json()).relations as { id: string }[]).map((r) => r.id);
    expect(team).toContain(ids['rel-r2']);
    expect(team).not.toContain(ids['rel-f1']);
    const foreignBefore = await snapshot('f1');
    for (const w of writes('f1')) {
      const res = await ctx.fetch(w.path, { method: w.method, data: w.data });
      expect(w.dropped ? [200, 201, 403, 404] : [403, 404], `${w.method} ${w.path} → ${res.status()}`).toContain(res.status());
    }
    expect(await snapshot('f1')).toEqual(foreignBefore);
  } finally {
    await ctx.dispose();
  }
});

test('the team board shows every card of the org; only your own moves, and a colleague’s opens read-only', async ({ page }) => {
  test.slow();
  await signIn(page, 'rep1');
  await gotoSettled(page, '/sales/board');
  const cards = page.getByTestId('board-card');
  const own = cards.filter({ hasText: `Team lead-r1 ${STAMP}` });
  const theirs = cards.filter({ hasText: `Team lead-r2 ${STAMP}` });
  await expect(own).toHaveCount(1, { timeout: 20_000 });
  await expect(theirs).toHaveCount(0);

  await page.getByTestId('sales-view-team').click();
  await page.waitForURL((u) => u.searchParams.get('view') === 'team');
  await expect(theirs).toHaveCount(1, { timeout: 20_000 });
  await expect(cards.filter({ hasText: `Team lead-f1 ${STAMP}` })).toHaveCount(0);
  await expect(own).toHaveAttribute('data-writable', 'true');
  await expect(theirs).toHaveAttribute('data-writable', 'false');
  await expect(theirs.getByTestId('board-card-owner')).toContainText(`Team rep2 ${STAMP}`);

  // Dragging a colleague's card does nothing — no request, no move.
  const target = page.getByTestId(`board-column-${stages[2]}`).first();
  await theirs.dragTo(target);
  await page.waitForLoadState('networkidle');
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids['rel-r2'] } })).pipelineStatus).toBe(stages[1]);

  // Your own moves.
  const put = page.waitForResponse((r) => r.url().includes(`/api/mentorship/${ids['rel-r1']}`) && r.request().method() === 'PUT');
  await own.dragTo(target);
  expect((await put).status()).toBe(200);
  await expect.poll(async () => (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids['rel-r1'] } })).pipelineStatus).toBe(stages[2]);

  // The view is in the URL: a reload keeps it.
  await gotoSettled(page, '/sales/board?view=team');
  await expect(theirs).toHaveCount(1, { timeout: 20_000 });

  // The colleague's card opens their page, read-only.
  await theirs.getByRole('link').first().click();
  await page.waitForURL((u) => u.pathname === `/sales/leads/${ids['rel-r2']}`, { timeout: 20_000 });
  await expect(page.getByTestId('sales-lead-readonly')).toBeVisible({ timeout: 20_000 });
});

test('switched off, a colleague’s record and account are a 404 again and the board offers no team view', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  await writeSetting('salesTeamBookForReps', 'false', orgA);
  try {
    const ctx = await jar(playwright, baseURL, 'rep1');
    try {
      expect((await ctx.get(`/sales/leads/${ids['rel-r2']}`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await ctx.get(`/sales/accounts/${ids['co-r2']}`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await ctx.get(`/sales/leads/${ids['rel-f1']}`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await ctx.get(`/sales/leads/${ids['rel-r1']}`, { maxRedirects: 0 })).status()).toBe(200);
    } finally {
      await ctx.dispose();
    }
    await signIn(page, 'rep1');
    await gotoSettled(page, '/sales/board?view=team');
    await expect(page.getByTestId('board-card').filter({ hasText: `Team lead-r1 ${STAMP}` })).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('sales-view')).toHaveCount(0);
    await expect(page.getByTestId('board-card').filter({ hasText: `Team lead-r2 ${STAMP}` })).toHaveCount(0);
  } finally {
    await writeSetting('salesTeamBookForReps', 'true', orgA);
  }
});

test('the dispatcher works every record: no banner, editors present, every card movable', async ({ page }) => {
  await signIn(page, 'disp');
  await gotoSettled(page, `/sales/leads/${ids['rel-r2']}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Team lead-r2 ${STAMP}`);
  await expect(page.getByTestId('follow-up-add')).toBeVisible();
  await expect(page.getByTestId('sales-lead-handoff')).toBeVisible();
  await expect(page.getByTestId('sales-lead-readonly')).toHaveCount(0);

  await gotoSettled(page, '/sales/board?view=team');
  const theirs = page.getByTestId('board-card').filter({ hasText: `Team lead-r2 ${STAMP}` });
  await expect(theirs).toHaveCount(1, { timeout: 20_000 });
  await expect(theirs).toHaveAttribute('data-writable', 'true');
});
