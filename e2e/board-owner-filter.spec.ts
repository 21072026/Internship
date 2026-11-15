import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * The admin board's owner filter (#3658): `?owners=` on GET /api/mentorship and
 * the "Owner" control on /admin/board. What this pins:
 *   - the filter is applied on the server — the cards AND the column counts are
 *     the named owners' only;
 *   - it narrows, never widens: a rep naming a colleague still gets their own
 *     records only (the scope stays its own conjunct);
 *   - malformed ids are dropped, not an error;
 *   - on the board, picking an owner leaves only their cards, the choice is in
 *     the URL, and every card shows its owner.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org.
 */

const PW = 'OwnerFilter123!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const emails = { admin: uniqueEmail('of-admin'), rep1: uniqueEmail('of-rep1'), rep2: uniqueEmail('of-rep2') };
const ids: Record<string, string> = {};
let orgId = '';
const contexts: APIRequestContext[] = [];
const api = {} as Record<keyof typeof emails, APIRequestContext>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${STAMP}`, slug: `owner-filter-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })) });
  ids.admin = (await seedUser(emails.admin, PW, 'ADMIN', `OF Admin ${STAMP}`, orgId)).id;
  ids.rep1 = (await seedUser(emails.rep1, PW, 'MENTOR', `Ada Rep ${STAMP}`, orgId)).id;
  ids.rep2 = (await seedUser(emails.rep2, PW, 'MENTOR', `Ben Rep ${STAMP}`, orgId)).id;
  const lead = async (label: string, ownerId: string, stage: string) => {
    const user = await prisma.user.create({
      data: { orgId, email: `of-${label}-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Lead ${label} ${STAMP}`, skills: [] },
    });
    ids[label] = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId: user.id, pipelineStatus: stage } })).id;
  };
  await lead('a1', ids.rep1, 'LEAD_NEW');
  await lead('a2', ids.rep1, 'LEAD_CONTACTED');
  await lead('b1', ids.rep2, 'LEAD_NEW');

  for (const key of Object.keys(emails) as (keyof typeof emails)[]) {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
    expect((await signInViaApi(ctx, emails[key], PW, { host: MARKETING_HOST })).ok, key).toBe(true);
    contexts.push(ctx);
    api[key] = ctx;
  }
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId, email: { endsWith: '@import.local' } } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

const board = async (who: keyof typeof emails, owners: string) => {
  const res = await api[who].get(`/api/mentorship?view=board&owners=${encodeURIComponent(owners)}`, { headers: host });
  expect(res.status()).toBe(200);
  return (await res.json()) as { relations: { id: string }[]; counts: Record<string, number> };
};

test('the server filters the cards and the counts by owner', { tag: '@smoke' }, async () => {
  const one = await board('admin', ids.rep1);
  expect(one.relations.map((r) => r.id).sort()).toEqual([ids.a1, ids.a2].sort());
  expect(one.counts).toMatchObject({ LEAD_NEW: 1, LEAD_CONTACTED: 1 });

  const both = await board('admin', `${ids.rep1},${ids.rep2}`);
  expect(both.relations).toHaveLength(3);
  expect(both.counts.LEAD_NEW).toBe(2);

  // Malformed ids are dropped: the board is the unfiltered one.
  const junk = await board('admin', "x'--,,%20");
  expect(junk.relations).toHaveLength(3);
});

test('the filter narrows, never widens: a rep naming a colleague sees only their own', { tag: '@smoke' }, async () => {
  expect((await board('rep1', ids.rep2)).relations).toHaveLength(0);
  expect((await board('rep1', `${ids.rep1},${ids.rep2}`)).relations.map((r) => r.id).sort()).toEqual([ids.a1, ids.a2].sort());
});

test('on the board: pick an owner, only their cards remain, the choice is in the URL', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.admin, PW, '/admin');
  await gotoSettled(page, '/admin/board');

  const cards = page.getByTestId('board-card');
  await expect(cards.filter({ hasText: STAMP })).toHaveCount(3);
  await expect(cards.filter({ hasText: `Lead b1 ${STAMP}` }).getByTestId('board-card-owner')).toContainText(`Ben Rep ${STAMP}`);

  await page.getByTestId('board-owner-filter').locator('summary').click();
  await page.getByTestId(`board-owner-option-${ids.rep2}`).check();
  await expect(cards.filter({ hasText: STAMP })).toHaveCount(1);
  await expect(cards.filter({ hasText: `Lead b1 ${STAMP}` })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('owners')).toBe(ids.rep2);
  // The column count is the server's, after the filter — not the cards left over.
  await expect(page.getByTestId('board-column-count-LEAD_NEW')).toHaveText('1');

  // A reload keeps the filter.
  await page.reload();
  await expect(cards.filter({ hasText: STAMP })).toHaveCount(1);

  await page.getByTestId('board-owner-filter').locator('summary').click();
  await page.getByTestId('board-owner-filter-clear').click();
  await expect(cards.filter({ hasText: STAMP })).toHaveCount(3);
});
