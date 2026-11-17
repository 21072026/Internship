import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// #3660: every board column can say what its stage means — an info icon in
// the header whose text shows on hover AND on keyboard focus. The sales funnel
// ships curated descriptions (in the reader's language, nothing stored); an
// admin can type their own in the stage editor, which is shown verbatim, and
// on the FREE plan the description is part of the locked look.

const PW = 'StageDescriptions123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
let orgId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Stages ${STAMP}`, slug: `sdesc-${STAMP}`, vertical: 'MARKETING', plan: 'ENTERPRISE' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  const ids: string[] = [];
  for (const [label, role] of [['admin', 'ADMIN'], ['rep', 'MENTOR'], ['lead', 'MENTEE']] as const) {
    const email = uniqueEmail(`sdesc-${label}-${STAMP}`).toLowerCase();
    emails.push(email);
    ids.push((await seedUser(email, PW, role, `Stages ${label} ${STAMP}`, orgId)).id);
  }
  // A board with no card shows an empty state instead of columns.
  await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids[1], menteeId: ids[2], pipelineStatus: 'LEAD_NEW' } });
});

test.afterAll(async () => {
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the sales board explains each stage behind an info icon a keyboard reaches', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');
  await gotoSettled(page, '/sales/board');
  await page.getByTestId('board-show-empty').check();

  const info = page.getByTestId('board-column-info-LEAD_QUALIFIED');
  const tip = page.getByTestId('board-column-description-LEAD_QUALIFIED');
  await expect(tip).toBeHidden();
  await info.focus();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('What the customer wants is clear and their request is defined.');
  await expect(info).toHaveAccessibleName('What “Qualified” means');
  await expect(info).toHaveAccessibleDescription('What the customer wants is clear and their request is defined.');
  // Nothing was stored: the curated text comes from the template.
  expect((await prisma.pipelineStage.findFirstOrThrow({ where: { orgId, key: 'LEAD_QUALIFIED' } })).description).toBeNull();
});

test('an admin types their own description; FREE keeps the curated one', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/admin');
  const url = `/api/admin/organizations/${orgId}/pipeline-stages`;
  type S = { key: string; description?: string | null };
  const stages = ((await (await page.request.get(url)).json()) as { stages: S[] }).stages;
  expect(stages.find((s) => s.key === 'LEAD_QUALIFIED')?.description).toMatch(/request is defined/);
  const withOwn = (text: string) => stages.map((s) => (s.key === 'LEAD_QUALIFIED' ? { ...s, description: text } : s));

  // Echoing the curated text stores nothing; a typed text is stored as typed.
  expect((await page.request.put(url, { data: { stages } })).ok()).toBe(true);
  expect(await prisma.pipelineStage.count({ where: { orgId, description: { not: null } } })).toBe(0);
  expect((await page.request.put(url, { data: { stages: withOwn(`Budget confirmed ${STAMP}`) } })).ok()).toBe(true);
  expect((await prisma.pipelineStage.findFirstOrThrow({ where: { orgId, key: 'LEAD_QUALIFIED' } })).description).toBe(`Budget confirmed ${STAMP}`);

  await gotoSettled(page, `/admin/organizations/${orgId}/pipeline`);
  await expect(page.getByTestId('stage-description-LEAD_QUALIFIED')).toHaveValue(`Budget confirmed ${STAMP}`);
  await expect(page.getByTestId('stage-description-LEAD_NEW')).toHaveValue('A new contact who has not been reached yet.');

  // On FREE the description is part of the locked look.
  await prisma.organization.update({ where: { id: orgId }, data: { plan: 'FREE' } });
  const refused = await page.request.put(url, { data: { stages: withOwn('Something else') } });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: 'plan_required' });
});

test('the rep sees the admin\'s own words', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');
  await gotoSettled(page, '/sales/board');
  await page.getByTestId('board-show-empty').check();
  await page.getByTestId('board-column-info-LEAD_QUALIFIED').hover();
  await expect(page.getByTestId('board-column-description-LEAD_QUALIFIED')).toHaveText(`Budget confirmed ${STAMP}`);
});
