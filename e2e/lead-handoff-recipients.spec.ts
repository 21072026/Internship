import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static import: Playwright resolves the `@/…` alias in the spec's import graph only.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * An org admin closes lead hand-offs to a person (#3979):
 * POST /api/admin/users/[id]/lead-handoffs, `User.acceptsLeadHandoffs`.
 *
 * Closed, the person is refused as a hand-off recipient (409
 * recipient_not_accepting) — by a rep and by the admin alike — and the board
 * offers them nowhere: not on the strip, not in the dialog's list. Their leads
 * stay reachable through the board's owner filter. Their own leads stay theirs. Only `user.write`
 * may switch it; another org's user is a 404.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'HandoffClose3979!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
let orgId = '';
let otherOrgId = '';
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } };

async function as(playwright: RequestFactory, baseURL: string | undefined, who: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
  contexts.push(ctx);
  const res = await signInViaApi(ctx, emails[who], PW, { host: MARKETING_HOST, headers: freshIp(`handoff-close-${who}`) });
  expect(res.error, `sign-in ${who}`).toBeNull();
  return ctx;
}

const setHandoffs = (ctx: APIRequestContext, userId: string, enabled: boolean) =>
  ctx.post(`/api/admin/users/${userId}/lead-handoffs`, { headers: host, data: { enabled } });
const handOff = (ctx: APIRequestContext, relationId: string, toUserId: string) =>
  ctx.post(`/api/sales/leads/${relationId}/handoff`, { headers: host, data: { toUserId, action: 'call' } });

async function person(key: string, role: 'MENTOR' | 'ADMIN', org: string) {
  emails[key] = uniqueEmail(`hc-${key}-${STAMP}`);
  ids[key] = (await seedUser(emails[key], PW, role, `HC ${key} ${STAMP}`, org)).id;
}

async function lead(key: string, ownerId: string) {
  const mentee = await prisma.user.create({
    data: { orgId, email: `hc-lead-${key}-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Contact HC ${key} ${STAMP}`, skills: [] },
  });
  return (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId: mentee.id, pipelineStatus: 'LEAD_CONTACTED' } })).id;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Handoff ${STAMP}`, slug: `hc-${STAMP}`, vertical: 'MARKETING' } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Acme Other ${STAMP}`, slug: `hc-o-${STAMP}`, vertical: 'MARKETING' } })).id;
  for (const o of [orgId, otherOrgId]) {
    await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: o })) });
  }
  await person('admin', 'ADMIN', orgId);
  await person('rep1', 'MENTOR', orgId);
  await person('rep2', 'MENTOR', orgId); // the one closed to hand-offs
  await person('foreign', 'ADMIN', otherOrgId);
  ids.rep1Lead = await lead('rep1', ids.rep1);
  ids.rep2Lead = await lead('rep2', ids.rep2);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const o of [orgId, otherOrgId]) {
    await prisma.followUpEvent.deleteMany({ where: { relation: { orgId: o } } }).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relation: { orgId: o } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: o } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: o, role: 'MENTEE' } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: o } }).catch(() => {});
  }
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  for (const o of [orgId, otherOrgId]) {
    await prisma.pipelineStage.deleteMany({ where: { orgId: o } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: o } }).catch(() => {});
  }
  await prisma.$disconnect();
});

type Member = { id: string; acceptsHandoffs: boolean };

test('an admin closes hand-offs to a person: the write refuses them, their own leads stay', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await as(playwright, baseURL, 'admin');
  const rep1 = await as(playwright, baseURL, 'rep1');
  const foreign = await as(playwright, baseURL, 'foreign');

  // Who may switch it: an org admin of the person's own org only.
  expect((await setHandoffs(rep1, ids.rep2, false)).status()).toBe(403);
  expect((await setHandoffs(foreign, ids.rep2, false)).status()).toBe(404);
  const closed = await setHandoffs(admin, ids.rep2, false);
  expect(closed.status()).toBe(200);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.rep2 }, select: { acceptsLeadHandoffs: true } })).acceptsLeadHandoffs).toBe(false);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'sales.handoffs_closed', targetId: ids.rep2 } })).toBe(1);

  // The team list says so.
  const team = (await (await rep1.get('/api/sales/team', { headers: host })).json()).members as Member[];
  expect(team.find((m) => m.id === ids.rep2)?.acceptsHandoffs).toBe(false);
  expect(team.find((m) => m.id === ids.admin)?.acceptsHandoffs).toBe(true);

  // A rep and the admin alike are refused, and nothing moves.
  for (const ctx of [rep1, admin]) {
    const refused = await handOff(ctx, ids.rep1Lead, ids.rep2);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe('recipient_not_accepting');
  }
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.rep1Lead }, select: { mentorId: true } })).mentorId).toBe(ids.rep1);
  // Their own lead is untouched, and may still be handed AWAY from them.
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.rep2Lead }, select: { mentorId: true, status: true } }))).toEqual({
    mentorId: ids.rep2,
    status: 'ACTIVE',
  });

  // Reopened: the same hand-off goes through.
  expect((await setHandoffs(admin, ids.rep2, true)).status()).toBe(200);
  expect((await handOff(rep1, ids.rep1Lead, ids.rep2)).status()).toBe(200);
  // Closed again for the board test below.
  expect((await setHandoffs(admin, ids.rep2, false)).status()).toBe(200);
});

test('the admin directory switches it, and the board neither offers nor accepts the person', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.admin, PW, '/admin');
  await gotoSettled(page, '/admin/users');
  await expect(page.getByTestId(`lead-handoffs-closed-badge-${ids.rep2}`)).toBeVisible();
  await expect(page.getByTestId(`lead-handoffs-toggle-${ids.rep2}`)).toHaveText('Open lead hand-offs');
  await expect(page.getByTestId(`lead-handoffs-toggle-${ids.rep1}`)).toHaveText('Close lead hand-offs');

  // On the admin board: rep2 is not on the strip, the dialog's list leaves them out.
  await gotoSettled(page, '/admin/board');
  await expect(page.getByTestId(`handoff-target-${ids.rep1}`)).toBeVisible();
  await expect(page.getByTestId(`handoff-target-${ids.rep2}`)).toHaveCount(0);
  const card = page.getByTestId('board-card').filter({ hasText: `Contact HC rep1 ${STAMP}` });
  await card.getByTestId('board-card-handoff').click();
  const select = page.getByTestId('lead-handoff-recipient');
  await expect(select.locator(`option[value="${ids.rep1}"]`)).toHaveCount(1);
  await expect(select.locator(`option[value="${ids.rep2}"]`)).toHaveCount(0);

  await page.keyboard.press('Escape');

  // Reopened from the directory: the confirm, then the badge is gone.
  await gotoSettled(page, '/admin/users');
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`lead-handoffs-toggle-${ids.rep2}`).click();
  await expect(page.getByTestId(`lead-handoffs-closed-badge-${ids.rep2}`)).toHaveCount(0);
  await expect(page.getByTestId(`lead-handoffs-toggle-${ids.rep2}`)).toHaveText('Close lead hand-offs');
  expect(await prisma.auditLog.count({ where: { orgId, action: 'sales.handoffs_opened', targetId: ids.rep2 } })).toBe(2);
});
