import crypto from 'crypto';
import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { TRIAL_ACTIVE_STAGE_KEY, TRIAL_EXPIRED_STAGE_KEY } from '../src/lib/trialReminderRule';

// The trial end on the sales lead page (#3647): the date reads as text with an
// Edit button — the follow-up panel's pattern — and the field opens on Edit.
// Who sees Edit is decided on the server with the trial route's own rule
// (owner, the tenant's sales dispatcher, an admin with relation.write) and the
// record must be open. A colleague neither opens the page nor gets through the
// API. Same PATCH, same rules: an expired trial moved to a later day reopens.

const PW = 'LeadTrialEdit123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
const H = asHost(MARKETING_HOST);
const utcDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';
// A stage outside the trial, and the label the tenant gave it.
let otherStage = { key: '', label: '' };

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`lte-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  return { ...(await seedUser(email, PW, role, `Trial ${label} ${STAMP}`, orgId)), email };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Trial ${STAMP}`, slug: `lte-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const presetStages = templateStagePayload(preset, 'en').stages;
  const other = presetStages.find((st) => st.key !== TRIAL_ACTIVE_STAGE_KEY && st.key !== TRIAL_EXPIRED_STAGE_KEY && !st.isTerminal);
  if (!other) throw new Error('MARKETING preset needs a non-trial stage');
  otherStage = { key: other.key, label: other.label };
  await prisma.pipelineStage.createMany({
    data: presetStages.map((st) => ({
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
  const colleague = await person('colleague', 'MENTOR');
  const lead = await person('lead', 'MENTEE');
  const closedLead = await person('closed-lead', 'MENTEE');
  const laterLead = await person('later-lead', 'MENTEE');
  ids.rep = rep.id;
  ids.colleague = colleague.id;
  // An expired trial: "Ended" on the page.
  ids.expired = (
    await prisma.mentorshipRelation.create({
      data: {
        orgId,
        mentorId: rep.id,
        menteeId: lead.id,
        pipelineStatus: TRIAL_EXPIRED_STAGE_KEY,
        trialStartedAt: new Date(`${utcDay(-40)}T00:00:00.000Z`),
        trialEndsAt: new Date(`${utcDay(-8)}T00:00:00.000Z`),
      },
    })
  ).id;
  // An open record that has moved on past its trial, still carrying the date.
  ids.later = (
    await prisma.mentorshipRelation.create({
      data: {
        orgId,
        mentorId: rep.id,
        menteeId: laterLead.id,
        pipelineStatus: otherStage.key,
        trialEndsAt: new Date(`${utcDay(-3)}T00:00:00.000Z`),
      },
    })
  ).id;
  // A closed record in a trial stage: shown, never editable.
  ids.closed = (
    await prisma.mentorshipRelation.create({
      data: {
        orgId,
        mentorId: rep.id,
        menteeId: closedLead.id,
        status: 'COMPLETED',
        pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
        trialEndsAt: new Date(`${utcDay(5)}T00:00:00.000Z`),
      },
    })
  ).id;
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

test('the owner edits the trial end from the read view; Cancel keeps it, Save moves the badge and reopens the trial', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.expired}`);

  const panel = page.getByTestId('trial-end-panel');
  await expect(panel.getByTestId('trial-end-status')).toHaveText('Ended');
  await expect(panel.getByTestId('trial-end-input')).toHaveCount(0);
  const edit = panel.getByRole('button', { name: 'Edit trial end' });
  await expect(edit).toBeVisible();

  // Cancel throws the edit away and gives the keyboard back to Edit.
  await edit.click();
  await expect(panel.getByTestId('trial-end-input')).toBeFocused();
  await panel.getByTestId('trial-end-input').fill(utcDay(3));
  await panel.getByTestId('trial-end-cancel').click();
  await expect(panel.getByTestId('trial-end-input')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Edit trial end' })).toBeFocused();
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.expired } })).trialEndsAt?.toISOString().slice(0, 10)).toBe(utcDay(-8));

  // Save: the badge moves at once and the panel returns to reading.
  const target = utcDay(7);
  await panel.getByTestId('trial-end-edit').click();
  await panel.getByTestId('trial-end-input').fill(target);
  await panel.getByTestId('trial-end-save').click();
  await expect(panel.getByTestId('trial-end-status')).toHaveText('7 days left');
  await expect(panel.getByTestId('trial-end-input')).toHaveCount(0);
  await expect(panel.getByTestId('trial-end-edit')).toBeVisible();
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.expired } });
  expect(row.trialEndsAt?.toISOString().slice(0, 10)).toBe(target);
  expect(row.pipelineStatus).toBe(TRIAL_ACTIVE_STAGE_KEY);

  // After the refresh the server's data says the same.
  await gotoSettled(page, `/sales/leads/${ids.expired}`);
  await expect(page.getByTestId('trial-end-panel').getByTestId('trial-end-status')).toHaveText('7 days left');

  // A closed record shows its trial end, no Edit — and says why (trialEndLockReason: 'closed').
  await gotoSettled(page, `/sales/leads/${ids.closed}`);
  const closedPanel = page.getByTestId('trial-end-panel');
  await expect(closedPanel.getByTestId('trial-end-status')).toBeVisible();
  await expect(closedPanel.getByTestId('trial-end-edit')).toHaveCount(0);
  await expect(closedPanel.getByTestId('trial-end-lock')).toContainText('The record is closed');
  await expect(closedPanel.getByTestId('trial-end-lock-reason')).toHaveCount(0);
  await closedPanel.getByRole('button', { name: "Why can't this be changed?" }).click();
  await expect(closedPanel.getByTestId('trial-end-lock-reason')).toHaveText('The trial end cannot be changed because the record is closed.');
});

test('outside a trial stage the owner sees why the date cannot change, with the stage as the tenant names it', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.later}`);
  const panel = page.getByTestId('trial-end-panel');
  await expect(panel.getByTestId('trial-end-status')).toHaveText('Ended');
  await expect(panel.getByTestId('trial-end-edit')).toHaveCount(0);
  // Readable on the screen, not only on hover: the short line, then the full reason on the info button.
  await expect(panel.getByTestId('trial-end-lock')).toContainText('Can be changed in a trial stage only');
  const info = panel.getByTestId('trial-end-lock-info');
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByTestId('trial-end-lock-reason')).toHaveText(
    `The trial end can only be changed while the lead is in a trial stage (Trial active / Trial expired). This record is currently in the '${otherStage.label}' stage.`,
  );
  // The server agrees: the same record is refused with not_in_trial.
  const res = await page.request.patch(`/api/mentorship/${ids.later}/trial`, { data: { trialEndsAt: utcDay(9) } });
  expect(res.status()).toBe(409);
  expect((await res.json()).code).toBe('not_in_trial');
});

test('a colleague reads the lead page without the editor and cannot move the trial end through the API', { tag: '@smoke' }, async ({ page }) => {
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[1], PW, '/sales');
  // The team view opens it read-only (src/lib/salesBookRule.ts).
  const res = await page.goto(`/sales/leads/${ids.expired}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('sales-lead-readonly')).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('trial-end-edit')).toHaveCount(0);

  const before = (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.expired } })).trialEndsAt?.toISOString();
  const api = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL, extraHTTPHeaders: H });
  try {
    expect((await signInViaApi(api, emails[1], PW, { host: MARKETING_HOST })).ok).toBe(true);
    const patch = await api.patch(`/api/mentorship/${ids.expired}/trial`, { data: { trialEndsAt: utcDay(20) } });
    expect([403, 404]).toContain(patch.status());
  } finally {
    await api.dispose();
  }
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.expired } })).trialEndsAt?.toISOString()).toBe(before);
});
