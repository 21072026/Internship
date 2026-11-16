import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { TRIAL_ACTIVE_STAGE_KEY } from '../src/lib/trialReminderRule';

// A lead marked lost while its trial still runs (#3813): the board card carries
// "Still in trial · N days left", the lead page a notice with "Back to trial".
// Nothing moves on its own. A lost lead whose trial already ran out shows
// nothing. A colleague (the team view) sees the notice but not the button.

const PW = 'LostTrialOpen123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
const H = asHost(MARKETING_HOST);
const utcDay = (offset: number) => new Date(`${new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`);

const emails: string[] = [];
const ids: Record<string, string> = {};
const names: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`lto-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  names[label] = `Lost ${label} ${STAMP}`;
  return { ...(await seedUser(email, PW, role, names[label], orgId)), email };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Lost ${STAMP}`, slug: `lto-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  const rep = await person('rep', 'MENTOR');
  await person('colleague', 'MENTOR');
  const lost = async (label: string, trialEndsAt: Date | null) => {
    const lead = await person(label, 'MENTEE');
    ids[label] = (
      await prisma.mentorshipRelation.create({
        data: {
          orgId,
          mentorId: rep.id,
          menteeId: lead.id,
          pipelineStatus: 'DEAL_LOST',
          trialStartedAt: trialEndsAt ? new Date(trialEndsAt.getTime() - 14 * DAY) : null,
          trialEndsAt,
        },
      })
    ).id;
  };
  await lost('open', utcDay(9)); // still in trial
  await lost('ended', utcDay(-3)); // trial ran out: a loss as far as the trial goes
  await lost('team', utcDay(5)); // for the colleague's read-only view
});

test.afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

const card = (page: import('@playwright/test').Page, label: string) =>
  page.getByTestId('board-card').filter({ hasText: names[label] }).filter({ visible: true });

test('the owner sees the chip and the notice, and moves the lead back to the trial', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  // The board: a chip on the lost card whose trial still runs, none on the ended one.
  await gotoSettled(page, '/sales/board');
  await expect(card(page, 'open').getByTestId('lost-trial-open-chip')).toHaveText('Still in trial · 9 days left');
  await expect(card(page, 'ended')).toBeVisible();
  await expect(card(page, 'ended').getByTestId('lost-trial-open-chip')).toHaveCount(0);

  // The ended one's lead page has no notice.
  await gotoSettled(page, `/sales/leads/${ids.ended}`);
  await expect(page.getByTestId('sales-lead-name')).toBeVisible();
  await expect(page.getByTestId('lost-trial-open-notice')).toHaveCount(0);

  // The open one: the notice, then "Back to trial".
  await gotoSettled(page, `/sales/leads/${ids.open}`);
  const notice = page.getByTestId('lost-trial-open-notice');
  await expect(notice).toContainText('Marked lost, but the trial is still running');
  await expect(notice).toContainText('9 days left');
  await notice.getByTestId('lost-trial-open-restore').click();
  await expect(page.getByText('The lead is back in the trial stage')).toBeVisible();
  await expect(page.getByTestId('lost-trial-open-notice')).toHaveCount(0);

  const after = await prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: ids.open },
    select: { pipelineStatus: true, trialEndsAt: true },
  });
  expect(after.pipelineStatus).toBe(TRIAL_ACTIVE_STAGE_KEY);
  // The trial window is kept, not restamped.
  expect(after.trialEndsAt?.toISOString()).toBe(utcDay(9).toISOString());
  // An ordinary stage move: it is in the history.
  const moves = await prisma.statusChange.findMany({ where: { relationId: ids.open }, select: { fromStatus: true, toStatus: true } });
  expect(moves).toContainEqual(expect.objectContaining({ fromStatus: 'DEAL_LOST', toStatus: TRIAL_ACTIVE_STAGE_KEY }));
});

test('a colleague sees the chip and the notice, without the button', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');

  await gotoSettled(page, '/sales/board?view=team');
  await expect(card(page, 'team').getByTestId('lost-trial-open-chip')).toHaveText('Still in trial · 5 days left');

  await gotoSettled(page, `/sales/leads/${ids.team}`);
  await expect(page.getByTestId('sales-lead-readonly')).toBeVisible();
  await expect(page.getByTestId('lost-trial-open-notice')).toContainText('Marked lost, but the trial is still running');
  await expect(page.getByTestId('lost-trial-open-restore')).toHaveCount(0);
  // And nothing moved.
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.team } })).pipelineStatus).toBe('DEAL_LOST');
});
