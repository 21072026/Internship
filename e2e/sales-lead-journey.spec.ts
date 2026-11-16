import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { writeSetting } from '../src/lib/settingsWrite';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A lead's journey across a hand-off (#3817, src/lib/leadJourney.ts). The
// hand-off closes the record and opens a new one with `previousRelationId`;
// nothing moves. The lead page reads the chain:
//   • the new owner sees "Taken over from …" and the earlier owner's period as
//     its own section, collapsed, with its interactions behind the toggle;
//   • the earlier owner, opening the old record, sees a banner naming the
//     current owner, with a link to the current record only when they may open it;
//   • a link that points at ANOTHER lead's record is not followed.

const PW = 'LeadJourney123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
const H = asHost(MARKETING_HOST);

const emails: string[] = [];
const ids: Record<string, string> = {};
const names: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`journey-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  names[label] = `Journey ${label} ${STAMP}`;
  const user = await seedUser(email, PW, role, names[label], orgId);
  ids[label] = user.id;
  return { id: user.id, email };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Journey ${STAMP}`, slug: `journey-${STAMP}`, vertical: 'MARKETING' },
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
  await person('earlier', 'MENTOR');
  await person('current', 'MENTOR');
  await person('lead', 'MENTEE');
  await person('other', 'MENTEE');

  const handedAt = new Date(Date.now() - 2 * DAY);
  const old = await prisma.mentorshipRelation.create({
    data: {
      orgId,
      mentorId: ids.earlier,
      menteeId: ids.lead,
      pipelineStatus: 'LEAD_QUALIFIED',
      status: 'COMPLETED',
      lifecycleState: 'ENDED_REASSIGNED',
      endReasonCode: 'sales_handoff',
      startDate: new Date(Date.now() - 20 * DAY),
      completedAt: handedAt,
    },
  });
  ids.old = old.id;
  await prisma.interactionLog.createMany({
    data: [
      { relationId: old.id, date: new Date(Date.now() - 10 * DAY), type: 'Meeting', subject: `First call ${STAMP}`, notes: 'Asked for pricing.' },
      { relationId: old.id, date: new Date(Date.now() - 5 * DAY), type: 'Email', subject: `Sent offer ${STAMP}`, notes: 'Offer attached.' },
    ],
  });
  const current = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ids.current, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED', previousRelationId: old.id, startDate: handedAt },
  });
  ids.currentRel = current.id;
  await prisma.interactionLog.create({
    data: { relationId: current.id, date: new Date(), type: 'Meeting', subject: `Follow-up call ${STAMP}`, notes: 'Reached them.' },
  });

  // Another lead's record whose chain link points at THIS lead's old record (a bad row).
  ids.foreignRel = (
    await prisma.mentorshipRelation.create({
      data: { orgId, mentorId: ids.current, menteeId: ids.other, pipelineStatus: 'LEAD_QUALIFIED', previousRelationId: old.id },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the new owner sees the earlier period, collapsed, and opens it', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.currentRel}`);

  await expect(page.getByTestId('sales-lead-taken-over')).toContainText(`Taken over from ${names.earlier}`);
  const rows = page.getByTestId('sales-lead-interactions');
  await expect(rows).toContainText(`Follow-up call ${STAMP}`);
  await expect(rows).not.toContainText(`First call ${STAMP}`);

  const period = page.getByTestId('sales-lead-earlier-period');
  await expect(period).toHaveCount(1);
  const toggle = period.getByTestId('sales-lead-earlier-toggle');
  await expect(toggle).toContainText(`${names.earlier}'s period`);
  await expect(toggle).toContainText('2 interactions');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sales-lead-earlier-interactions')).toHaveCount(0);

  await toggle.click();
  const earlier = page.getByTestId('sales-lead-earlier-interactions');
  await expect(earlier).toContainText(`First call ${STAMP}`);
  await expect(earlier).toContainText(`Sent offer ${STAMP}`);

  // The choice is remembered in this browser.
  await gotoSettled(page, `/sales/leads/${ids.currentRel}`);
  await expect(page.getByTestId('sales-lead-earlier-interactions')).toContainText(`First call ${STAMP}`);

  // Nothing was moved: the earlier interactions still hang on the earlier record.
  expect(await prisma.interactionLog.count({ where: { relationId: ids.old } })).toBe(2);
});

test("a chain link to another lead's record is not followed", async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.foreignRel}`);
  await expect(page.getByTestId('sales-lead-name')).toBeVisible();
  await expect(page.getByTestId('sales-lead-earlier-period')).toHaveCount(0);
  await expect(page.getByTestId('sales-lead-taken-over')).toHaveCount(0);
});

test('the earlier owner sees who carries the lead now, and the link only while they may open it', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  // Team read on (the default): the banner links to the current record.
  await gotoSettled(page, `/sales/leads/${ids.old}`);
  const banner = page.getByTestId('sales-lead-handed-on');
  await expect(banner).toContainText(`its owner is now ${names.current}`);
  await expect(page.getByTestId('sales-lead-readonly')).toHaveCount(0);
  await banner.getByTestId('sales-lead-handed-on-link').click();
  await expect(page).toHaveURL(new RegExp(`/sales/leads/${ids.currentRel}$`));

  // Team read off: the current record is not theirs to open, so no link.
  await writeSetting('salesTeamBookForReps', 'false', orgId);
  await gotoSettled(page, `/sales/leads/${ids.old}`);
  await expect(page.getByTestId('sales-lead-handed-on')).toContainText(names.current);
  await expect(page.getByTestId('sales-lead-handed-on-link')).toHaveCount(0);
});
