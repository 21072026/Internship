import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static import, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Handing a lead to a colleague (#3672; refs #3657, #2578):
// POST /api/sales/leads/[id]/handoff, GET /api/sales/team and the board dialog.
//
// Pins the answers src/lib/leadHandoff.ts and src/lib/salesPoolGate.ts give
// today, code for code:
//   • the owner hands their own lead on — the owner and the follow-up change,
//     the new owner gets a `lead.handedOff` bell that opens /sales, and the
//     sender no longer lists it;
//   • not yours = 404 `missing` (same body as an id that does not exist), and
//     another org's lead is 404 for the org's own admin too;
//   • 400 `same_owner` / `invalid_recipient` / `invalid_date`;
//   • the MARKETING ORG_ADMIN may hand off any lead of the org;
//   • INTERNSHIP callers get 403 `vertical_unavailable`, a MENTEE or COMPANY
//     login a plain 403, on both routes.
// The rep's own probes against a colleague's and another org's lead id are
// rows of the role × endpoint matrix (MARKETING_MENTOR_ROWS, run by
// e2e/marketing-sales-surface.spec.ts) and are not repeated here.

test.describe.configure({ mode: 'serial' });

const PW = 'LeadHandoff123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

const orgIds: string[] = [];
const emails: string[] = [];
const companyIds: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Handoff ${label} ${STAMP}`, slug: `handoff-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  return org.id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY', orgId: string, extra: { companyId?: string; isActive?: boolean } = {}) {
  const email = uniqueEmail(`handoff-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `Handoff ${label} ${STAMP}`, orgId);
  if (extra.companyId || extra.isActive === false) {
    await prisma.user.update({
      where: { id: user.id },
      data: { ...(extra.companyId ? { companyId: extra.companyId } : {}), ...(extra.isActive === false ? { isActive: false } : {}) },
    });
  }
  ids[label] = user.id;
  mail[label] = email;
  return user.id;
}

/** A lead (MENTEE record) on `ownerId`'s book, in the record's first sales stage. */
async function lead(label: string, ownerId: string, orgId: string) {
  const menteeId = await person(`lead-${label}`, 'MENTEE', orgId);
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId, pipelineStatus: 'LEAD_QUALIFIED' },
  });
  ids[`rel-${label}`] = rel.id;
  return rel.id;
}

/** An API-only session for `label`, on the marketing host when `marketing`. */
async function jar(
  playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
  label: string,
  marketing: boolean,
) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: marketing ? asHost(MARKETING_HOST) : {} });
  const res = await signInViaApi(ctx, mail[label], PW, { ...(marketing ? { host: MARKETING_HOST } : {}), headers: freshIp(`handoff-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

const handoffPath = (relationId: string) => `/api/sales/leads/${relationId}/handoff`;

async function owner(relationId: string) {
  return (await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, select: { mentorId: true } }))?.mentorId;
}

test.beforeAll(async () => {
  const orgA = await marketingOrg('a');
  const orgB = await marketingOrg('b');
  const internship = await prisma.organization.create({
    data: { name: `Handoff INT ${STAMP}`, slug: `handoff-int-${STAMP}`, vertical: 'INTERNSHIP' },
  });
  orgIds.push(internship.id);
  ids.orgA = orgA;

  await person('rep1', 'MENTOR', orgA);
  await person('rep2', 'MENTOR', orgA);
  await person('rep3', 'MENTOR', orgA, { isActive: false });
  // Active when the UI dialog opens, deactivated while it is open.
  await person('rep4', 'MENTOR', orgA);
  await person('admin', 'ADMIN', orgA);
  await person('mentee', 'MENTEE', orgA);
  const account = await prisma.company.create({ data: { orgId: orgA, name: `Handoff Login Co ${STAMP}` } });
  companyIds.push(account.id);
  await person('company', 'COMPANY', orgA, { companyId: account.id });
  await person('foreignRep', 'MENTOR', orgB);
  await person('intMentor', 'MENTOR', internship.id);
  await person('intAdmin', 'ADMIN', internship.id);

  await lead('happy', ids.rep1, orgA);
  await lead('refusals', ids.rep1, orgA);
  await lead('ui', ids.rep1, orgA);
  await lead('page', ids.rep1, orgA);
  await lead('colleague', ids.rep2, orgA);
  await lead('adminMoves', ids.rep2, orgA);
  await lead('foreign', ids.foreignRep, orgB);
});

test.afterAll(async () => {
  const userIds = Object.entries(ids).filter(([k]) => !k.startsWith('rel-') && k !== 'orgA').map(([, v]) => v);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a lead that is not yours, or not your org’s, is a 404 that confirms nothing', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.slow();
  const rep1 = await jar(playwright, baseURL, 'rep1', true);
  const admin = await jar(playwright, baseURL, 'admin', true);
  const body = { toUserId: ids.rep1, action: 'call' };

  // A colleague's lead, by its owner's colleague: `missing`, the very body a
  // made-up id gets — so a 404 is no oracle for "this id exists".
  const colleague = await rep1.post(handoffPath(ids['rel-colleague']), { data: body });
  expect(colleague.status()).toBe(404);
  const colleagueBody = await colleague.json();
  expect(colleagueBody).toEqual({ error: 'Hand-off refused', code: 'missing' });
  const madeUp = await rep1.post(handoffPath(`x${STAMP}missing`), { data: body });
  expect(madeUp.status()).toBe(404);
  expect(await madeUp.json()).toEqual(colleagueBody);

  // Another org's lead is out of reach of this org's admin as well, who may
  // otherwise hand off any lead of their own org.
  const foreign = await admin.post(handoffPath(ids['rel-foreign']), { data: { toUserId: ids.rep1, action: 'call' } });
  expect(foreign.status()).toBe(404);
  const foreignText = await foreign.text();
  expect(JSON.parse(foreignText)).toEqual({ error: 'Hand-off refused', code: 'missing' });
  expect(foreignText).not.toContain(ids['rel-foreign']);
  expect(foreignText).not.toContain(ids.foreignRep);

  expect(await owner(ids['rel-colleague'])).toBe(ids.rep2);
  expect(await owner(ids['rel-foreign'])).toBe(ids.foreignRep);
  await rep1.dispose();
  await admin.dispose();
});

test('only a MARKETING seller gets in: INTERNSHIP is vertical_unavailable, a lead or customer login a plain 403', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.slow();
  const callers: Array<{ label: string; marketing: boolean; code: string | undefined }> = [
    { label: 'intMentor', marketing: false, code: 'vertical_unavailable' },
    { label: 'intAdmin', marketing: false, code: 'vertical_unavailable' },
    { label: 'mentee', marketing: true, code: undefined },
    { label: 'company', marketing: true, code: undefined },
  ];
  for (const c of callers) {
    const ctx = await jar(playwright, baseURL, c.label, c.marketing);
    const team = await ctx.get('/api/sales/team');
    expect(team.status(), `${c.label} GET /api/sales/team`).toBe(403);
    expect((await team.json()).code, `${c.label} team code`).toBe(c.code);
    const handoff = await ctx.post(handoffPath(ids['rel-refusals']), { data: { toUserId: ids.rep2, action: 'call' } });
    expect(handoff.status(), `${c.label} POST handoff`).toBe(403);
    expect((await handoff.json()).code, `${c.label} handoff code`).toBe(c.code);
    await ctx.dispose();
  }
  expect(await owner(ids['rel-refusals'])).toBe(ids.rep1);
});

test('the team is the active ADMINs and MENTORs of the caller’s org, the caller marked', async ({ playwright, baseURL }) => {
  const rep1 = await jar(playwright, baseURL, 'rep1', true);
  const res = await rep1.get('/api/sales/team');
  expect(res.status()).toBe(200);
  const members = (await res.json()).members as Array<{ id: string; self: boolean; fullName: string; avatarUrl: string | null }>;
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const label of ['rep1', 'rep2', 'rep4', 'admin']) expect(byId.has(ids[label]), label).toBe(true);
  for (const label of ['rep3', 'mentee', 'company', 'foreignRep', 'intMentor']) expect(byId.has(ids[label]), label).toBe(false);
  expect(byId.get(ids.rep1)?.self).toBe(true);
  expect(byId.get(ids.rep2)?.self).toBe(false);
  // Names and avatars, nothing else.
  expect(Object.keys(members[0]).sort()).toEqual(['avatarUrl', 'fullName', 'id', 'self']);
  await rep1.dispose();
});

test('the refusals before anything moves: same_owner, invalid_recipient, invalid_date', async ({ playwright, baseURL }) => {
  const rep1 = await jar(playwright, baseURL, 'rep1', true);
  const path = handoffPath(ids['rel-refusals']);
  const cases: Array<{ data: Record<string, unknown>; code: string; why: string }> = [
    { data: { toUserId: ids.rep1, action: 'call' }, code: 'same_owner', why: 'the recipient already owns it' },
    { data: { toUserId: ids.rep3, action: 'call' }, code: 'invalid_recipient', why: 'the recipient is deactivated' },
    { data: { toUserId: ids.foreignRep, action: 'call' }, code: 'invalid_recipient', why: 'the recipient is another org’s rep' },
    { data: { toUserId: ids.mentee, action: 'call' }, code: 'invalid_recipient', why: 'the recipient is a lead, not a seller' },
    { data: { toUserId: ids.rep2, action: 'call', dueOn: '2026-02-30' }, code: 'invalid_date', why: 'a day that does not exist' },
  ];
  for (const c of cases) {
    const res = await rep1.post(path, { data: c.data });
    expect(res.status(), c.why).toBe(400);
    expect((await res.json()).code, c.why).toBe(c.code);
  }
  const row = await prisma.mentorshipRelation.findUnique({ where: { id: ids['rel-refusals'] } });
  expect(row?.mentorId).toBe(ids.rep1);
  expect(row?.nextActionNote ?? null).toBeNull();
  expect(await prisma.notification.count({ where: { userId: ids.rep2, type: 'lead.handedOff' } })).toBe(0);
  await rep1.dispose();
});

test('the owner hands their lead on: owner and next step move, the recipient is told on /sales, the sender no longer lists it', async ({ playwright, baseURL }) => {
  const rep1 = await jar(playwright, baseURL, 'rep1', true);
  const due = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await rep1.post(handoffPath(ids['rel-happy']), {
    data: { toUserId: ids.rep2, action: 'call', note: 'ask about the pricing tier', dueOn: due },
  });
  expect(res.status()).toBe(200);
  const out = await res.json();
  // A record with no history is corrected in place: same id, new owner.
  expect(out).toEqual({ relationId: ids['rel-happy'], mode: 'corrected', toName: `Handoff rep2 ${STAMP}` });

  const row = await prisma.mentorshipRelation.findUnique({ where: { id: out.relationId } });
  expect(row?.mentorId).toBe(ids.rep2);
  expect(row?.nextActionNote).toBe('Call: ask about the pricing tier');
  expect(row?.nextActionAt?.toISOString().slice(0, 10)).toBe(due);

  const bell = await prisma.notification.findFirst({ where: { userId: ids.rep2, type: 'lead.handedOff' } });
  expect(bell?.link).toBe(`/sales/leads/${out.relationId}`);
  expect(bell?.link?.startsWith('/mentor')).toBe(false);
  // The lead hears nothing about who works it.
  expect(await prisma.notification.count({ where: { userId: ids['lead-happy'] } })).toBe(0);

  const list = await rep1.get('/api/mentorship');
  expect(list.status()).toBe(200);
  const listed = ((await list.json()).relations ?? []) as Array<{ id: string }>;
  expect(listed.map((r) => r.id)).not.toContain(out.relationId);
  expect(listed.map((r) => r.id)).toContain(ids['rel-refusals']);
  await rep1.dispose();
});

test('the MARKETING org admin may hand off any lead of the org; its previous owner hears it left their book', async ({ playwright, baseURL }) => {
  const admin = await jar(playwright, baseURL, 'admin', true);
  const res = await admin.post(handoffPath(ids['rel-adminMoves']), { data: { toUserId: ids.rep1, action: 'demo' } });
  expect(res.status()).toBe(200);
  expect((await res.json()).relationId).toBe(ids['rel-adminMoves']);
  expect(await owner(ids['rel-adminMoves'])).toBe(ids.rep1);
  const told = await prisma.notification.findFirst({ where: { userId: ids.rep1, type: 'lead.handedOff' } });
  expect(told?.link).toBe(`/sales/leads/${ids['rel-adminMoves']}`);
  const away = await prisma.notification.findFirst({
    where: { userId: ids.rep2, type: { in: ['mentorship.assignmentCorrected', 'mentorship.reassignedAway'] } },
  });
  expect(away?.link).toBe('/sales');
  await admin.dispose();
});

test('the board dialog: a recipient deactivated while it is open is refused in place, then the hand-off goes through', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep1, PW, '/sales');
  await gotoSettled(page, '/sales/board');

  const card = page.getByTestId('board-card').filter({ hasText: `Handoff lead-ui ${STAMP}` });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('lead-handoff-strip')).toBeVisible();
  await card.getByTestId('board-card-handoff').click();
  const dialog = page.getByTestId('lead-handoff-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('lead-handoff-recipient').selectOption(ids.rep4);

  // The colleague leaves while the dialog is open.
  await prisma.user.update({ where: { id: ids.rep4 }, data: { isActive: false } });
  await dialog.getByTestId('lead-handoff-confirm').click();
  await expect(dialog.getByTestId('lead-handoff-error')).toBeVisible();
  expect(await owner(ids['rel-ui'])).toBe(ids.rep1);

  await dialog.getByTestId('lead-handoff-recipient').selectOption(ids.rep2);
  await dialog.getByTestId('lead-handoff-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => owner(ids['rel-ui'])).toBe(ids.rep2);
  await expect(page.getByTestId('board-card').filter({ hasText: `Handoff lead-ui ${STAMP}` })).toHaveCount(0);
});

test('the lead page hands the record over too (#3657): same dialog, then back to /sales', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep1, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids['rel-page']}`);

  await page.getByTestId('sales-lead-handoff').click();
  const dialog = page.getByTestId('lead-handoff-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('lead-handoff-recipient').selectOption(ids.rep2);
  await dialog.getByTestId('lead-handoff-confirm').click();

  // The record left the rep's book: the page would 404, so the rep is back on /sales.
  await page.waitForURL((u) => u.pathname === '/sales', { timeout: 20_000 });
  await expect.poll(() => owner(ids['rel-page'])).toBe(ids.rep2);
  const moved = await prisma.mentorshipRelation.findFirst({
    where: { menteeId: ids['lead-page'], status: 'ACTIVE' },
    select: { mentorId: true, nextActionAt: true },
  });
  expect(moved?.mentorId).toBe(ids.rep2);
  expect(moved?.nextActionAt).not.toBeNull();
});

