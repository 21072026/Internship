import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// #3837: a meeting planned on a lead leaves a line in the lead's history —
// "Meeting scheduled for <when>", in the viewer's zone — and a cancelled one
// a second line. Read from the Meeting rows; nothing lands in InteractionLog
// (planning a meeting is not a contact: the last-contact rule, the counters
// and the billing meter read that log).

const PW = 'MeetingLines123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Meetings ${STAMP}`, slug: `smeet-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  for (const [label, role] of [['rep', 'MENTOR'], ['lead', 'MENTEE']] as const) {
    const email = uniqueEmail(`smeet-${label}-${STAMP}`).toLowerCase();
    emails.push(email);
    ids[label] = (await seedUser(email, PW, role, `Meetings ${label} ${STAMP}`, orgId)).id;
  }
  // The rep reads times in Berlin: 09:30 UTC is 10:30 there in January.
  await prisma.user.update({ where: { id: ids.rep }, data: { timezone: 'Europe/Berlin' } });
  ids.rel = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
});

test.afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a planned and a cancelled meeting each leave a history line, and no interaction', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  const plan = (title: string, scheduledAt: string) =>
    page.request.post('/api/meetings', { data: { relationIds: [ids.rel], title, scheduledAt, meetLink: '' } });
  expect((await plan(`Demo call ${STAMP}`, '2027-01-15T09:30:00.000Z')).ok()).toBe(true);
  expect((await plan(`Pricing call ${STAMP}`, '2027-01-20T09:30:00.000Z')).ok()).toBe(true);
  const pricing = await prisma.meeting.findFirstOrThrow({ where: { relationId: ids.rel, title: `Pricing call ${STAMP}` } });
  const cancel = await page.request.patch(`/api/meetings/${pricing.id}`, { data: { status: 'CANCELLED' } });
  expect(cancel.ok()).toBe(true);

  // Planning is not a contact.
  expect(await prisma.interactionLog.count({ where: { relationId: ids.rel } })).toBe(0);

  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  const lines = page.locator('[data-testid="sales-lead-system-row"][data-source="meeting"]');
  await expect(lines).toHaveCount(3);
  // Newest first: the cancellation, then the two plans — times in Berlin.
  await expect(lines.nth(0)).toContainText('Meeting on 20 Jan 2027, 10:30 (GMT+1) cancelled');
  await expect(lines.nth(0)).toContainText(`Pricing call ${STAMP}`);
  await expect(page.getByTestId('sales-lead-interactions')).toContainText('Meeting scheduled for 15 Jan 2027, 10:30 (GMT+1)');
  await expect(page.getByTestId('sales-lead-interactions')).toContainText(`Demo call ${STAMP}`);

  // They are system lines: the "Interactions" filter hides them.
  await page.getByTestId('sales-lead-interaction-filter-interactions').click();
  await expect(lines).toHaveCount(0);
});

test('meetings planned from the lead page show up one after another, without a reload (#3853)', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  // The newest line sits on top; the card shows the first few rows, so each new
  // meeting is checked as the top line rather than by a count.
  const lines = page.locator('[data-testid="sales-lead-system-row"][data-source="meeting"]');
  for (let i = 1; i <= 3; i++) {
    await page.getByTestId('sales-lead-plan-meeting').click();
    const dialog = page.getByTestId('plan-meeting-dialog');
    await dialog.getByTestId('plan-meeting-date').fill(`2027-02-0${i}`);
    await dialog.getByTestId('plan-meeting-title-input').fill(`Follow-up ${i} ${STAMP}`);
    await dialog.getByRole('button', { name: /plan|schedule|create|save/i }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect(lines.first()).toContainText(`Follow-up ${i} ${STAMP}`);
  }
});
