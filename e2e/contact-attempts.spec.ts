import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Contact attempts (#3902). A call nobody answered is logged with
// outcome NOT_REACHED: the lead shows it (badge, count, its own filter, the
// timeline's `attempt` kind), but it is NOT contact — it moves no stage through
// the first-contact advance and leaves last contact where it was. Only a Call or
// a WhatsApp can be unanswered. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'Attempt3902Pass!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`att-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `ATT ${label} ${STAMP}`, orgId)).id;
  return email;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ATT ${STAMP}`, slug: `att-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  // The first-contact advance is on: an attempt must still not trigger it.
  await prisma.setting.create({ data: { orgId, key: 'firstContactAutoAdvance', value: 'on' } });
  await person('rep', 'MENTOR');
  await person('lead', 'MENTEE');
  ids.rel = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_NEW' } })).id;
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('an unanswered call is an attempt: shown and counted on the lead, but no stage move and no contact', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  // Only a Call or a WhatsApp can be unanswered.
  const refused = await page.request.post('/api/interactions', {
    data: { relationId: ids.rel, date: new Date().toISOString().slice(0, 10), type: 'Email', notes: 'x', outcome: 'NOT_REACHED' },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('outcome_not_allowed');

  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await page.getByTestId('interaction-form-open').first().click();
  // The checkbox belongs to the attemptable types only.
  await expect(page.getByTestId('interaction-form-not-reached')).toHaveCount(0);
  await page.getByTestId('interaction-form-type').selectOption('Call');
  await page.getByTestId('interaction-form-not-reached').check();
  await page.getByPlaceholder(/notes/i).last().fill(`No answer ${STAMP}`);
  await page.getByRole('button', { name: /log interaction/i }).last().click();

  const attemptRow = page.getByTestId('sales-lead-interaction-row').filter({ hasText: `No answer ${STAMP}` });
  await expect(attemptRow).toHaveAttribute('data-outcome', 'NOT_REACHED');
  await expect(attemptRow.getByTestId('sales-lead-attempt-badge')).toBeVisible();

  const stored = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: ids.rel, notes: `No answer ${STAMP}` } });
  expect(stored.outcome).toBe('NOT_REACHED');
  // The first-contact advance is on, yet nobody was reached: the lead stays new.
  await page.waitForTimeout(500);
  const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.rel }, select: { pipelineStatus: true } });
  expect(rel.pipelineStatus).toBe('LEAD_NEW');

  // A contact beside it, through the API.
  const contact = await page.request.post('/api/interactions', {
    data: { relationId: ids.rel, date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), type: 'Call', notes: `Spoke ${STAMP}` },
  });
  expect(contact.ok()).toBe(true);

  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await expect(page.getByTestId('sales-lead-attempt-count')).toContainText('1');
  await page.getByTestId('sales-lead-interaction-filter-attempts').click();
  await expect(page.getByTestId('sales-lead-interaction-row')).toHaveCount(1);
  await expect(page.getByTestId('sales-lead-interaction-row')).toContainText(`No answer ${STAMP}`);
  await page.getByTestId('sales-lead-interaction-filter-interactions').click();
  await expect(page.getByTestId('sales-lead-interaction-row')).toHaveCount(1);
  await expect(page.getByTestId('sales-lead-interaction-row')).toContainText(`Spoke ${STAMP}`);

  // The timeline lists the attempt under its own kind, not as an interaction.
  const tl = await page.request.get(`/api/mentorship/${ids.rel}/timeline`);
  expect(tl.ok()).toBe(true);
  const entries = (await tl.json()).entries as { kind: string; event: string; detail?: string | null }[];
  expect(entries.filter((e) => e.kind === 'attempt').map((e) => e.event)).toEqual(['interaction_attempt']);
  expect(entries.filter((e) => e.kind === 'interaction')).toHaveLength(1);

  // Editing an attempt into an Email is refused: an Email cannot be unanswered.
  const edit = await page.request.put(`/api/interactions/${stored.id}`, { data: { type: 'Email' } });
  expect(edit.status()).toBe(400);
  expect((await edit.json()).code).toBe('outcome_not_allowed');
});
