import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The lead page's interaction filter and stage history (#3820). One
// chronological list holds the interactions and the system lines — follow-up
// history (#3819) and the stage moves read from StatusChange; a segmented
// "All · Interactions · System" control narrows it, remembered in the browser.

const PW = 'InteractionFilter123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const HOUR = 60 * 60 * 1000;

const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`ifilter-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  const user = await seedUser(email, PW, role, `Filter ${label} ${STAMP}`, orgId);
  ids[label] = user.id;
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Filter ${STAMP}`, slug: `ifilter-${STAMP}`, vertical: 'MARKETING' },
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
  await person('rep', 'MENTOR');
  await person('lead', 'MENTEE');
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED' },
  });
  ids.rel = rel.id;
  // A second lead with an interaction and no system line: no filter control (#3879).
  await person('bareLead', 'MENTEE');
  ids.bare = (
    await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.bareLead, pipelineStatus: 'LEAD_QUALIFIED' } })
  ).id;
  await prisma.interactionLog.create({
    data: { relationId: ids.bare, date: new Date(Date.now() - HOUR), type: 'Email', subject: `Bare email ${STAMP}`, notes: 'Sent.' },
  });
  await prisma.interactionLog.create({
    data: { relationId: rel.id, date: new Date(Date.now() - 2 * HOUR), type: 'Call', subject: `Intro call ${STAMP}`, notes: 'Reached them.' },
  });
  await prisma.statusChange.create({
    data: { relationId: rel.id, fromStatus: 'LEAD_CONTACTED', toStatus: 'LEAD_QUALIFIED', changedById: ids.rep, createdAt: new Date(Date.now() - HOUR) },
  });
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the filter narrows one list of interactions, follow-up lines and stage moves, and is remembered', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  expect((await page.request.put(`/api/mentorship/${ids.rel}`, { data: { nextActionAt: '2026-12-01', nextActionNote: `Send pricing ${STAMP}` } })).ok()).toBe(true);

  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  const list = page.getByTestId('sales-lead-interactions');
  const filter = page.getByTestId('sales-lead-interaction-filter');
  await expect(filter.getByTestId('sales-lead-interaction-filter-all')).toHaveAttribute('aria-pressed', 'true');

  // All: everything, in time order — the follow-up line (now), the stage move, the call.
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list.locator('li').nth(0)).toContainText(`Send pricing ${STAMP}`);
  await expect(list.locator('li').nth(1)).toContainText('Stage: Contacted → Qualified');
  await expect(list.locator('li').nth(2)).toContainText(`Intro call ${STAMP}`);
  await expect(page.locator('[data-testid="sales-lead-system-row"][data-source="stage"]')).toHaveCount(1);

  // Interactions: the call only.
  await filter.getByTestId('sales-lead-interaction-filter-interactions').click();
  await expect(list.locator('li')).toHaveCount(1);
  await expect(page.getByTestId('sales-lead-interaction-row')).toContainText(`Intro call ${STAMP}`);

  // System: the two system lines, and the choice survives a reload.
  await filter.getByTestId('sales-lead-interaction-filter-system').click();
  await expect(page.getByTestId('sales-lead-system-row')).toHaveCount(2);
  await expect(page.getByTestId('sales-lead-interaction-row')).toHaveCount(0);
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await expect(page.getByTestId('sales-lead-interaction-filter-system')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sales-lead-system-row')).toHaveCount(2);
  await expect(page.getByTestId('sales-lead-interaction-row')).toHaveCount(0);
});

test('a remembered "System" does not hide the interactions of a lead with no system line (#3879)', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  await page.evaluate(() => window.localStorage.setItem('sales.lead.interactionFilter', 'system'));

  await gotoSettled(page, `/sales/leads/${ids.bare}`);
  await expect(page.getByTestId('sales-lead-interaction-row')).toContainText(`Bare email ${STAMP}`);
  await expect(page.getByTestId('sales-lead-interaction-filter')).toHaveCount(0);
  await expect(page.getByTestId('sales-lead-interactions-empty')).toHaveCount(0);

  // The choice itself is kept: the lead that has the control still opens on System.
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await expect(page.getByTestId('sales-lead-interaction-filter-system')).toHaveAttribute('aria-pressed', 'true');
});
