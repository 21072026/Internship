import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// First contact moves a lead on (#3746). A fixed rule outside the automation
// engine: with `firstContactAutoAdvance = on`, a Call/Meeting/Email/WhatsApp logged on
// an ACTIVE lead still on the pipeline's FIRST stage moves it to the target
// (blank = LEAD_CONTACTED). Never a note, never from a later stage, never with
// the switch off, never in INTERNSHIP. The decision is unit-tested in
// scripts/test/first-contact-advance-rule.test.mjs; this pins the wiring —
// the shared write path, the activity row, the toast and its Undo.

test.describe.configure({ mode: 'serial' });

const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = 'FirstContact123!';
const repEmail = uniqueEmail(`fca-rep-${STAMP}`);
const adminEmail = uniqueEmail(`fca-admin-${STAMP}`);
const internEmail = uniqueEmail(`fca-intern-admin-${STAMP}`);
const leadEmails = ['ui', 'note', 'second', 'off', 'intern'].map((n) => uniqueEmail(`fca-lead-${n}-${STAMP}`));
const orgIds: string[] = [];
const rel: Record<string, string> = {};
let marketingOrg = '';
let internOrg = '';

async function user(email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', name: string, orgId: string) {
  const u = await seedUser(email, PASSWORD, role, name);
  await prisma.user.update({ where: { id: u.id }, data: { orgId } });
  return u.id;
}

async function setSetting(orgId: string, key: string, value: string) {
  await prisma.setting.deleteMany({ where: { orgId, key, programId: null } });
  await prisma.setting.create({ data: { orgId, key, value } });
}

async function stageOf(id: string) {
  return (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: { pipelineStatus: true } })).pipelineStatus;
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `FCA ${STAMP}`, slug: `fca-${STAMP}`, vertical: 'MARKETING' } });
  marketingOrg = org.id;
  orgIds.push(org.id);
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const rep = await user(repEmail, 'MENTOR', `FCA Rep ${STAMP}`, org.id);
  await user(adminEmail, 'ADMIN', `FCA Admin ${STAMP}`, org.id);
  const stages: Record<string, string> = { ui: 'LEAD_NEW', note: 'LEAD_NEW', second: 'LEAD_CONTACTED', off: 'LEAD_NEW' };
  for (const [i, key] of ['ui', 'note', 'second', 'off'].entries()) {
    const lead = await user(leadEmails[i], 'MENTEE', `FCA Lead ${key} ${STAMP}`, org.id);
    const r = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep, menteeId: lead, pipelineStatus: stages[key] } });
    rel[key] = r.id;
  }

  const intern = await prisma.organization.create({ data: { name: `FCA Intern ${STAMP}`, slug: `fca-intern-${STAMP}`, vertical: 'INTERNSHIP' } });
  internOrg = intern.id;
  orgIds.push(intern.id);
  const internAdmin = await user(internEmail, 'ADMIN', `FCA Intern Admin ${STAMP}`, intern.id);
  const internLead = await user(leadEmails[4], 'MENTEE', `FCA Intern Lead ${STAMP}`, intern.id);
  const ir = await prisma.mentorshipRelation.create({ data: { orgId: intern.id, mentorId: internAdmin, menteeId: internLead } });
  rel.intern = ir.id;
});

test.afterAll(async () => {
  for (const email of [repEmail, adminEmail, internEmail, ...leadEmails]) await cleanupByEmail(email);
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('settings: MARKETING stores the switch and a pipeline stage; an unknown stage and INTERNSHIP are refused', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
  const ok = await page.request.put('/api/admin/settings', { data: { firstContactAutoAdvance: 'on', firstContactTargetStage: '' } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).settings.firstContactAutoAdvance).toBe('on');
  const unknown = await page.request.put('/api/admin/settings', { data: { firstContactTargetStage: 'NOT_A_STAGE' } });
  expect(unknown.status()).toBe(400);
  expect((await unknown.json()).error).toBe('unknown_stage');
  // The settings card and the automation page's status line.
  await gotoSettled(page, '/admin/settings');
  await expect(page.getByTestId('first-contact-advance-toggle')).toBeChecked();
  await gotoSettled(page, '/admin/automations');
  await expect(page.getByTestId('first-contact-advance-note')).toHaveAttribute('data-mode', 'on');

  await page.context().clearCookies();
  await page.context().setExtraHTTPHeaders({});
  await signInAndSettle(page, internEmail, PASSWORD, '/admin');
  const refused = await page.request.put('/api/admin/settings', { data: { firstContactAutoAdvance: 'on' } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe('vertical_mismatch');
});

test('a call on a first-stage lead moves it to Contacted, shows in the activity, and Undo moves it back', async ({ page }) => {
  await setSetting(marketingOrg, 'firstContactAutoAdvance', 'on');
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PASSWORD, '/sales');
  await gotoSettled(page, `/sales/leads/${rel.ui}`);
  const form = page.getByTestId('sales-lead-log-interaction');
  await form.getByRole('button', { name: /log|add/i }).first().click();
  await form.locator('select').first().selectOption('Call');
  await form.locator('textarea').fill('Called — they want a demo next week.');
  await form.locator('button[type="submit"]').click();

  await expect(page.getByText('Lead moved to Contacted')).toBeVisible();
  await expect.poll(() => stageOf(rel.ui)).toBe('LEAD_CONTACTED');
  // Through the shared write path: the history row is the system's, and the
  // activity names the interaction that caused it.
  const change = await prisma.statusChange.findFirst({ where: { relationId: rel.ui }, orderBy: { createdAt: 'desc' } });
  expect(change).toMatchObject({ fromStatus: 'LEAD_NEW', toStatus: 'LEAD_CONTACTED', changedById: null });
  const activity = await prisma.activityLog.findFirst({ where: { targetId: rel.ui, action: 'pipeline.stage_change' }, orderBy: { createdAt: 'desc' } });
  expect(activity?.detail).toMatch(/^LEAD_NEW → LEAD_CONTACTED \(automatic: first contact — Call interaction \w+\)$/);
  await gotoSettled(page, `/sales/leads/${rel.ui}`);
  await expect(page.getByTestId('sales-lead-stage')).toHaveText('Contacted');

  // A second contact on the same lead moves nothing: it is no longer on the first stage.
  const again = await page.request.post('/api/interactions', { data: { relationId: rel.ui, date: new Date().toISOString(), notes: 'Follow-up call', type: 'Call' } });
  expect(again.status()).toBe(201);
  const againBody = await again.json();
  expect(againBody.stageAdvance).toBeNull();
  // The person who logged it is its author (#3818), not merely "the relation's mentor".
  const repId = (await prisma.user.findFirstOrThrow({ where: { email: repEmail, orgId: marketingOrg }, select: { id: true } })).id;
  expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: againBody.interaction.id }, select: { authorId: true } })).authorId).toBe(repId);

  // Undo, from the toast of a fresh move.
  await prisma.mentorshipRelation.update({ where: { id: rel.ui }, data: { pipelineStatus: 'LEAD_NEW' } });
  await gotoSettled(page, `/sales/leads/${rel.ui}`);
  await form.getByRole('button', { name: /log|add/i }).first().click();
  await form.locator('select').first().selectOption('Email');
  await form.locator('textarea').fill('Sent the intro mail.');
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => stageOf(rel.ui)).toBe('LEAD_CONTACTED');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stageOf(rel.ui)).toBe('LEAD_NEW');
});

test('a note, a lead past the first stage and a switched-off org move nothing', async ({ page }) => {
  await setSetting(marketingOrg, 'firstContactAutoAdvance', 'on');
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PASSWORD, '/sales');
  const log = (relationId: string, type: string) =>
    page.request.post('/api/interactions', { data: { relationId, date: new Date().toISOString(), notes: `${type} logged`, type } });

  const note = await log(rel.note, 'Feedback');
  expect(note.status()).toBe(201);
  expect((await note.json()).stageAdvance).toBeNull();
  expect(await stageOf(rel.note)).toBe('LEAD_NEW');

  // Second stage, and a target further on: still never moved — only from the FIRST stage.
  await setSetting(marketingOrg, 'firstContactTargetStage', 'LEAD_QUALIFIED');
  expect((await (await log(rel.second, 'Call')).json()).stageAdvance).toBeNull();
  expect(await stageOf(rel.second)).toBe('LEAD_CONTACTED');
  await prisma.setting.deleteMany({ where: { orgId: marketingOrg, key: 'firstContactTargetStage' } });

  await setSetting(marketingOrg, 'firstContactAutoAdvance', 'off');
  expect((await (await log(rel.off, 'Call')).json()).stageAdvance).toBeNull();
  expect(await stageOf(rel.off)).toBe('LEAD_NEW');
});

test('INTERNSHIP never moves, even with a row that says on', async ({ page }) => {
  // The API refuses to store it there (first test); a row written by hand is read as off.
  await setSetting(internOrg, 'firstContactAutoAdvance', 'on');
  await signInAndSettle(page, internEmail, PASSWORD, '/admin');
  const res = await page.request.post('/api/interactions', { data: { relationId: rel.intern, date: new Date().toISOString(), notes: 'First call', type: 'Call' } });
  expect(res.status()).toBe(201);
  expect((await res.json()).stageAdvance).toBeNull();
  expect(await stageOf(rel.intern)).toBe('APPLICATION_100');
});
