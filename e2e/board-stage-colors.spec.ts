import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// #3661: a board column wears its stage's OWN color — the one the admin picks
// in the pipeline editor, preset by the sales funnel — and falls back to the
// positional tone (#3666) when the stage has none or a stored value is not a
// plain hex color.

const PW = 'StageColors123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
let orgId = '';
let email = '';
let relId = '';

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Colors ${STAMP}`, slug: `scolors-${STAMP}`, vertical: 'MARKETING' },
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
      // One stored value that is not a color: it must never reach a style.
      color: st.key === 'LEAD_CONTACTED' ? 'url(x)' : st.color,
    })),
  });
  email = uniqueEmail(`scolors-rep-${STAMP}`).toLowerCase();
  const rep = await seedUser(email, PW, 'MENTOR', `Colors rep ${STAMP}`, orgId);
  const lead = await seedUser(uniqueEmail(`scolors-lead-${STAMP}`).toLowerCase(), PW, 'MENTEE', `Colors lead ${STAMP}`, orgId);
  relId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: rep.id, menteeId: lead.id, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
});

test.afterAll(async () => {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, email: { not: email } } }).catch(() => {});
  await cleanupByEmail(email);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('sales board columns take the stage colors; a bad stored value falls back', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, email, PW, '/sales');
  await gotoSettled(page, '/sales/board');
  await page.getByTestId('board-show-empty').check();

  // Qualified is #8b5cf6 in the preset: the top stripe is the color itself.
  const qualified = page.getByTestId('board-column-LEAD_QUALIFIED');
  await expect(qualified).toHaveCSS('border-top-color', 'rgb(139, 92, 246)');
  await expect(qualified).toHaveCSS('border-top-width', '4px');
  // Won is green, so two stages are told apart by their own colors.
  await expect(page.getByTestId('board-column-DEAL_WON')).toHaveCSS('border-top-color', 'rgb(22, 163, 74)');

  // The stored "url(x)" is not a color: positional tone, no inline style.
  const contacted = page.getByTestId('board-column-LEAD_CONTACTED');
  await expect(contacted).toHaveClass(/bg-orange-100/);
  expect(await contacted.getAttribute('style')).toBeNull();
  expect(relId).not.toBe('');
});
