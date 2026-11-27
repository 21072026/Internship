import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
// Static import: Playwright resolves the `@/…` alias in the spec's import graph only.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * "What do the badges mean?" on the board (#3977): a panel opened from the
 * board header explains the stage clock (grey / red), the follow-up day and,
 * on the sales board, the trial end; the follow-up chip says the same on hover.
 * The open state is remembered per browser.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'BoardLegend3977!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const repEmail = uniqueEmail(`bl-rep-${STAMP}`);
let orgId = '';

test.use({ locale: 'en-GB' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Legend ${STAMP}`, slug: `bl-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })) });
  const rep = await seedUser(repEmail, PW, 'MENTOR', `BL Rep ${STAMP}`, orgId);
  const lead = await prisma.user.create({
    data: { orgId, email: `bl-lead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Contact BL ${STAMP}`, skills: [] },
  });
  await prisma.mentorshipRelation.create({
    data: {
      orgId, mentorId: rep.id, menteeId: lead.id, pipelineStatus: 'LEAD_CONTACTED',
      nextActionAt: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`), nextActionType: 'call', nextActionNote: 'Call back',
    },
  });
});

test.afterAll(async () => {
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  await cleanupByEmail(repEmail);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the board explains its badges, and remembers the panel is open', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PW, '/sales');
  await gotoSettled(page, '/sales/board');

  const toggle = page.getByTestId('board-legend-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('board-legend')).toHaveCount(0);

  await toggle.click();
  const legend = page.getByTestId('board-legend');
  await expect(legend).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const row of ['stage-days', 'stage-overdue', 'follow-up', 'trial']) {
    await expect(legend.getByTestId(`board-legend-${row}`)).toBeVisible();
  }
  await expect(legend.getByTestId('board-legend-stage-overdue')).toContainText('exclamation');
  await expect(legend.getByTestId('board-legend-follow-up')).toContainText('the day you plan to do the next step');

  // The chip on the card says the same on hover.
  await expect(page.getByTestId('follow-up-chip').first()).toHaveAttribute('title', /the day you plan to do the next step/);

  // Remembered after a reload; the close button folds it again.
  await page.reload();
  await expect(page.getByTestId('board-legend')).toBeVisible();
  await page.getByTestId('board-legend-close').click();
  await expect(page.getByTestId('board-legend')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('board-legend-toggle')).toBeVisible();
  await expect(page.getByTestId('board-legend')).toHaveCount(0);
});
