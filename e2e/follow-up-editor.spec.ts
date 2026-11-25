import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// One follow-up editor (#3903): the lead page's follow-up panel and the
// hand-off dialog offer the same fields — what is next, when (quick day or a
// day, optional time) and the words — with the same rule (`other` needs words).
// A step entered on either screen reads back the same. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'Europe/Berlin', locale: 'en-GB' });

const PW = 'FollowUp3903Pass!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`fue-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `FUE ${label} ${STAMP}`, orgId)).id;
  return email;
}

/** Tomorrow in Berlin as YYYY-MM-DD — what the "Tomorrow" chip fills in. */
function berlinTomorrow(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Fill the shared editor: an e-mail tomorrow at 14:30 with the given words. */
async function fillStep(scope: ReturnType<Page['getByTestId']>, prefix: string, words: string) {
  await scope.getByTestId(`${prefix}-action-email`).check({ force: true });
  await scope.getByTestId(`${prefix}-quick-1`).click();
  await scope.getByTestId(`${prefix}-time`).fill('14:30');
  await scope.getByTestId(`${prefix}-note`).fill(words);
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales FUE ${STAMP}`, slug: `fue-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  await person('rep', 'MENTOR');
  await person('rep2', 'MENTOR');
  await person('leadA', 'MENTEE');
  await person('leadB', 'MENTEE');
  ids.relA = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.leadA, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
  ids.relB = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.leadB, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the panel and the hand-off dialog take the same step and read it back the same', async ({ page, browser }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  const words = `Send the price list ${STAMP}`;
  const tomorrow = berlinTomorrow();

  // Lead A, through the follow-up panel.
  await gotoSettled(page, `/sales/leads/${ids.relA}`);
  await page.getByTestId('follow-up-add').click();
  const panel = page.getByTestId('follow-up-form');
  // `other` without words is refused here, as in the dialog.
  await panel.getByTestId('follow-up-action-other').check({ force: true });
  await page.getByTestId('follow-up-save').click();
  await expect(panel).toContainText('Write what should happen.');
  await fillStep(panel, 'follow-up', words);
  await page.getByTestId('follow-up-save').click();
  await expect(page.getByTestId('follow-up-read-type')).toHaveText('Send an e-mail');
  const a = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.relA }, select: { nextActionAt: true, nextActionTime: true, nextActionType: true, nextActionNote: true } });
  expect(a).toMatchObject({ nextActionTime: '14:30', nextActionType: 'email', nextActionNote: words });
  expect(a.nextActionAt?.toISOString()).toBe(`${tomorrow}T00:00:00.000Z`);

  // Lead B, through the hand-off dialog on its lead page.
  await gotoSettled(page, `/sales/leads/${ids.relB}`);
  await page.getByTestId('sales-lead-handoff').click();
  const dialog = page.getByTestId('lead-handoff-dialog');
  await dialog.getByTestId('lead-handoff-recipient').selectOption(ids.rep2);
  await dialog.getByTestId('lead-handoff-action-other').check({ force: true });
  await expect(dialog.getByTestId('lead-handoff-confirm')).toBeDisabled();
  await fillStep(dialog, 'lead-handoff', words);
  await dialog.getByTestId('lead-handoff-confirm').click();
  await page.waitForURL((u) => u.pathname === '/sales', { timeout: 20_000 });
  const b = await prisma.mentorshipRelation.findFirstOrThrow({
    where: { menteeId: ids.leadB, status: 'ACTIVE' },
    select: { id: true, nextActionAt: true, nextActionTime: true, nextActionType: true },
  });
  expect(b).toMatchObject({ nextActionTime: '14:30', nextActionType: 'email' });
  expect(b.nextActionAt?.toISOString()).toBe(`${tomorrow}T00:00:00.000Z`);

  // The new owner reads the hand-off's step exactly as lead A's reads: the pick, then the words.
  const ctx = await browser.newContext({ extraHTTPHeaders: H, timezoneId: 'Europe/Berlin', locale: 'en-GB' });
  const rep2 = await ctx.newPage();
  await signInAndSettle(rep2, emails[1], PW, '/sales');
  await gotoSettled(rep2, `/sales/leads/${b.id}`);
  await expect(rep2.getByTestId('follow-up-read-type')).toHaveText('Send an e-mail');
  await expect(rep2.getByTestId('follow-up-read-note')).toHaveText(words);
  await expect(rep2.getByTestId('follow-up-read-time')).toHaveText(' · 14:30');
  await ctx.close();

  await gotoSettled(page, `/sales/leads/${ids.relA}`);
  await expect(page.getByTestId('follow-up-read-note')).toHaveText(words);
  await expect(page.getByTestId('follow-up-read-time')).toHaveText(' · 14:30');

  // The route makes the same check: `other` with no words is refused.
  const bad = await page.request.put(`/api/mentorship/${ids.relA}`, { data: { nextActionType: 'other', nextActionNote: '' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).code).toBe('note_required');
});
