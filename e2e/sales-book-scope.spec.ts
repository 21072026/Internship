import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { writeSetting } from '../src/lib/settingsWrite';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The sales surface: the viewer's OWN book is the default list and the write
// scope; READING is the team's (src/lib/salesBookRule.ts).
//
// The first bug (#3755): /sales/board listed what GET /api/mentorship lets the
// role read — the whole tenant for an ORG_ADMIN or OBSERVER — while
// /sales/leads/<id> opened only `mentorId = self`, so a colleague's card was on
// the board and clicking it was a 404. The list stays the own book. Then the
// team view (2026-11-15): while `salesTeamBookForReps` is on (the default) a
// rep opens every record page of the org, a colleague's read-only (pinned in
// e2e/sales-team-view.spec.ts); an admin and the dispatcher always do. Off, a
// rep's colleague's record is a 404 again. The admin board keeps the whole book
// and opens the admin detail (/admin/candidates/<menteeId>), never the sales
// lead page.

test.describe.configure({ mode: 'serial' });

const PW = 'SalesBook123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
const emails: string[] = [];
let orgId = '';

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`book-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `Book ${label} ${STAMP}`, orgId)).id;
  mail[label] = email;
}

async function record(label: string, ownerId: string) {
  await person(`lead-${label}`, 'MENTEE');
  ids[`rel-${label}`] = (await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: ids[`lead-${label}`], pipelineStatus: 'LEAD_QUALIFIED' },
  })).id;
}

async function jar(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, baseURL: string | undefined, label: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const res = await signInViaApi(ctx, mail[label], PW, { host: MARKETING_HOST, headers: freshIp(`book-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Book ${STAMP}`, slug: `book-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  await person('rep1', 'MENTOR');
  await person('rep2', 'MENTOR');
  await person('disp', 'MENTOR');
  await prisma.user.update({ where: { id: ids.disp }, data: { salesDispatcher: true } });
  await person('orgAdmin', 'ADMIN');
  await person('observer', 'ADMIN');
  await prisma.user.update({ where: { id: ids.observer }, data: { adminLevel: 'OBSERVER' } });
  await record('r1', ids.rep1);
  await record('r2', ids.rep2);
  // An admin who also sells: their own record is on their sales book.
  await record('a1', ids.orgAdmin);
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

// Who sees which record on /sales (the list): the own book; the dispatcher the tenant's.
const BOOK: Record<string, string[]> = {
  rep1: ['r1'],
  rep2: ['r2'],
  orgAdmin: ['a1'],
  observer: [],
  disp: ['r1', 'r2', 'a1'],
};
const ALL = ['r1', 'r2', 'a1'];

test('the sales list is the viewer’s own book; with the team read every record of the org opens, without it a rep’s colleague’s is a 404', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  // Off: a rep opens their own only; an admin (any tier) and the dispatcher read the team either way.
  const OPENS_WITHOUT_TEAM_READ: Record<string, string[]> = { rep1: ['r1'], rep2: ['r2'], orgAdmin: ALL, observer: ALL, disp: ALL };
  for (const teamSetting of ['true', 'false'] as const) {
    await writeSetting('salesTeamBookForReps', teamSetting, orgId);
    for (const [viewer, own] of Object.entries(BOOK)) {
      const ctx = await jar(playwright, baseURL, viewer);
      try {
        const res = await ctx.get('/api/mentorship?surface=sales');
        expect(res.status(), viewer).toBe(200);
        const listed = ((await res.json()).relations as { id: string }[]).map((r) => r.id).filter((id) => ALL.some((k) => ids[`rel-${k}`] === id));
        expect(listed.sort(), viewer).toEqual(own.map((k) => ids[`rel-${k}`]).sort());
        const opens = teamSetting === 'true' ? ALL : OPENS_WITHOUT_TEAM_READ[viewer];
        for (const k of ALL) {
          const page = await ctx.get(`/sales/leads/${ids[`rel-${k}`]}`, { maxRedirects: 0 });
          expect(page.status(), `${viewer} → ${k} (team ${teamSetting})`).toBe(opens.includes(k) ? 200 : 404);
        }
      } finally {
        await ctx.dispose();
      }
    }
  }
  await writeSetting('salesTeamBookForReps', 'true', orgId);
});

test('surface=sales only narrows: without it an org admin still reads the whole tenant (the admin surfaces)', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const ctx = await jar(playwright, baseURL, 'orgAdmin');
  try {
    const all = ((await (await ctx.get('/api/mentorship')).json()).relations as { id: string }[]).map((r) => r.id);
    for (const k of ALL) expect(all, k).toContain(ids[`rel-${k}`]);
    // An unknown surface value is ignored, never a wider list either.
    const odd = ((await (await ctx.get('/api/mentorship?surface=everything')).json()).relations as { id: string }[]).map((r) => r.id);
    expect(odd.sort()).toEqual(all.sort());
  } finally {
    await ctx.dispose();
  }
});

test('on /sales/board an org admin sees only their own card, and it opens', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.orgAdmin, PW, '/admin');
  await gotoSettled(page, '/sales/board');
  const cards = page.getByTestId('board-card');
  await expect(cards.filter({ hasText: `Book lead-a1 ${STAMP}` })).toHaveCount(1, { timeout: 20_000 });
  await expect(cards.filter({ hasText: `Book lead-r1 ${STAMP}` })).toHaveCount(0);
  await expect(cards.filter({ hasText: `Book lead-r2 ${STAMP}` })).toHaveCount(0);
  // A client-side navigation (next/link): the lead page renders, not the 404.
  await cards.filter({ hasText: `Book lead-a1 ${STAMP}` }).getByRole('link').click();
  await page.waitForURL((u) => u.pathname === `/sales/leads/${ids['rel-a1']}`, { timeout: 20_000 });
  await expect(page.getByTestId('sales-lead-stage')).toBeVisible({ timeout: 20_000 });
});

test('the dispatcher’s board holds the whole book and a colleague’s card opens', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.disp, PW, '/sales');
  await gotoSettled(page, '/sales/board');
  const card = page.getByTestId('board-card').filter({ hasText: `Book lead-r2 ${STAMP}` });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.getByRole('link').click();
  await page.waitForURL((u) => u.pathname === `/sales/leads/${ids['rel-r2']}`, { timeout: 20_000 });
  await expect(page.getByTestId('sales-lead-stage')).toBeVisible({ timeout: 20_000 });
});

test('the admin board keeps the whole book and its cards open the admin detail, never the sales lead page', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.orgAdmin, PW, '/admin');
  await gotoSettled(page, '/admin/board');
  for (const k of ALL) {
    const card = page.getByTestId('board-card').filter({ hasText: `Book lead-${k} ${STAMP}` });
    await expect(card, k).toHaveCount(1, { timeout: 20_000 });
    await expect(card.getByRole('link').first()).toHaveAttribute('href', `/admin/candidates/${ids[`lead-${k}`]}`);
  }
});
