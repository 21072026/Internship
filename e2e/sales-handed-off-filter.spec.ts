import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static imports: Playwright resolves the `@/…` alias in the spec's import graph only.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { writeSetting } from '../src/lib/settingsWrite';

/**
 * "Handed on by me" on the team board (#3980): GET /api/sales/team-book
 * ?handedOff=1 and the board's toggle. A record counts when its LAST hand-off
 * took it from the viewer (or was done by them) and it is not back with them
 * (`handedOnBy`, src/lib/leadHandoffRule.ts). A colleague's lead, a lead that
 * was passed on again by someone else, and a lead that came back do not. It is
 * the team read: off for reps, no toggle and a 404.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run; the hand-offs go through
 * the real route.
 */

const PW = 'HandedOff3980!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
let orgId = '';
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } };

async function as(playwright: RequestFactory, baseURL: string | undefined, who: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
  contexts.push(ctx);
  const res = await signInViaApi(ctx, emails[who], PW, { host: MARKETING_HOST, headers: freshIp(`handed-off-${who}`) });
  expect(res.error, `sign-in ${who}`).toBeNull();
  return ctx;
}

/** Hand a record on through the real route; the id of the record the recipient now owns. */
async function handOff(ctx: APIRequestContext, relationId: string, toUserId: string): Promise<string> {
  const res = await ctx.post(`/api/sales/leads/${relationId}/handoff`, { headers: host, data: { toUserId, action: 'call' } });
  expect(res.status(), `hand-off ${relationId}`).toBe(200);
  return (await res.json()).relationId as string;
}

async function person(key: string, role: 'MENTOR' | 'ADMIN') {
  emails[key] = uniqueEmail(`ho-${key}-${STAMP}`);
  ids[key] = (await seedUser(emails[key], PW, role, `HO ${key} ${STAMP}`, orgId)).id;
}

const leadName = (key: string) => `Contact HO ${key} ${STAMP}`;
async function lead(key: string, ownerId: string) {
  const mentee = await prisma.user.create({
    data: { orgId, email: `ho-lead-${key}-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: leadName(key), skills: [] },
  });
  return (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId: mentee.id, pipelineStatus: 'LEAD_CONTACTED' } })).id;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme HandedOff ${STAMP}`, slug: `ho-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })) });
  await person('me', 'MENTOR');
  await person('rep2', 'MENTOR');
  await person('rep3', 'MENTOR');
  ids.passed = await lead('passed', ids.me); // me → rep2: counts
  ids.passedAgain = await lead('passed-again', ids.me); // me → rep2 → rep3: not mine any more
  ids.cameBack = await lead('came-back', ids.me); // me → rep2 → me: back with me
  ids.colleague = await lead('colleague', ids.rep2); // never mine
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  await writeSetting('salesTeamBookForReps', 'true', orgId).catch(() => {});
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

type Row = { id: string; leadName: string; ownerId: string };

test('handed on by me: the last hand-off was mine and the lead is not back with me', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const me = await as(playwright, baseURL, 'me');
  const rep2 = await as(playwright, baseURL, 'rep2');
  ids.passedNow = await handOff(me, ids.passed, ids.rep2);
  const again = await handOff(me, ids.passedAgain, ids.rep2);
  await handOff(rep2, again, ids.rep3);
  const back = await handOff(me, ids.cameBack, ids.rep2);
  await handOff(rep2, back, ids.me);

  const book = await (await me.get('/api/sales/team-book?handedOff=1', { headers: host })).json();
  const names = (book.rows as Row[]).map((r) => r.leadName);
  expect(names).toEqual([leadName('passed')]);
  expect((book.rows as Row[])[0].ownerId).toBe(ids.rep2);
  expect(book.total).toBe(1);

  // Without the filter the whole team's book is there, the colleague's lead included.
  const all = (await (await me.get('/api/sales/team-book', { headers: host })).json()).rows as Row[];
  expect(all.map((r) => r.leadName)).toEqual(expect.arrayContaining([leadName('passed'), leadName('passed-again'), leadName('came-back'), leadName('colleague')]));

  // It is always the caller's own: rep2's "handed on" is the lead they passed to rep3 and the one they gave back.
  const theirs = ((await (await rep2.get('/api/sales/team-book?handedOff=1', { headers: host })).json()).rows as Row[]).map((r) => r.leadName).sort();
  expect(theirs).toEqual([leadName('came-back'), leadName('passed-again')].sort());
});

test('the board toggle narrows the team view, and is not offered without the team read', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.me, PW, '/sales');
  await gotoSettled(page, '/sales/board?view=team');
  const toggle = page.getByTestId('board-handed-off-filter');
  await expect(toggle).toHaveText('Handed on by me');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('board-card').filter({ hasText: leadName('colleague') })).toHaveCount(1, { timeout: 20_000 });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForURL((u) => u.searchParams.get('handedOff') === '1');
  await expect(page.getByTestId('board-card').filter({ hasText: leadName('passed') })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('board-card').filter({ hasText: leadName('colleague') })).toHaveCount(0);
  await expect(page.getByTestId('board-card').filter({ hasText: leadName('passed-again') })).toHaveCount(0);
  // Remembered in the URL.
  await page.reload();
  await expect(page.getByTestId('board-handed-off-filter')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('board-card').filter({ hasText: leadName('colleague') })).toHaveCount(0);

  // Team read off for reps: no team view, no toggle, and the API is a 404.
  await writeSetting('salesTeamBookForReps', 'false', orgId);
  await gotoSettled(page, '/sales/board?view=team&handedOff=1');
  await expect(page.getByTestId('board-handed-off-filter')).toHaveCount(0);
  expect((await page.request.get('/api/sales/team-book?handedOff=1')).status()).toBe(404);
});
