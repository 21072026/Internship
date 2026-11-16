import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A record's follow-up history (#3819, src/lib/followUpEvents.ts). Every write
// that changes the follow-up leaves exactly one FollowUpEvent row — set,
// changed, completed, removed, handed over — in the same transaction:
//   • an unchanged resend and a racing double write still make one row;
//   • nothing lands in InteractionLog (a follow-up is not a contact);
//   • the lead page shows the lines, muted, among the interactions;
//   • a hand-off is ONE line on the record the new owner gets.

const PW = 'FollowUpHistory123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);

const emails: string[] = [];
const ids: Record<string, string> = {};
const names: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`fuh-${label}-${STAMP}`).toLowerCase();
  emails.push(email);
  names[label] = `History ${label} ${STAMP}`;
  const user = await seedUser(email, PW, role, names[label], orgId);
  ids[label] = user.id;
  return email;
}

const events = (relationId: string) =>
  prisma.followUpEvent.findMany({ where: { relationId }, orderBy: { createdAt: 'asc' }, select: { kind: true, actorId: true, fromUserId: true, toUserId: true, toNote: true } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales History ${STAMP}`, slug: `fuh-${STAMP}`, vertical: 'MARKETING' },
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
  await person('colleague', 'MENTOR');
  await person('lead', 'MENTEE');
  ids.rel = (
    await prisma.mentorshipRelation.create({
      data: { orgId, mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED' },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('each follow-up edit is one history line, never an interaction', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  const put = (data: Record<string, unknown>) => page.request.put(`/api/mentorship/${ids.rel}`, { data });

  // Set — and the same request again is no change, so no second line.
  expect((await put({ nextActionAt: '2026-12-01', nextActionNote: `Call about pricing ${STAMP}` })).ok()).toBe(true);
  expect((await put({ nextActionAt: '2026-12-01', nextActionNote: `Call about pricing ${STAMP}` })).ok()).toBe(true);
  expect((await events(ids.rel)).map((e) => e.kind)).toEqual(['ASSIGNED']);

  // Moved: two copies of the same click racing each other still make ONE line.
  const [a, b] = await Promise.all([put({ nextActionAt: '2026-12-03' }), put({ nextActionAt: '2026-12-03' })]);
  expect(a.ok() && b.ok()).toBe(true);
  expect((await events(ids.rel)).map((e) => e.kind)).toEqual(['ASSIGNED', 'CHANGED']);

  // Completed (the panel's Complete) and removed (the panel's Clear) read differently.
  expect((await put({ nextActionAt: null, nextActionNote: null, nextActionCompleted: true })).ok()).toBe(true);
  expect((await put({ nextActionAt: '2026-12-05', nextActionNote: null })).ok()).toBe(true);
  expect((await put({ nextActionAt: null, nextActionNote: null })).ok()).toBe(true);
  const rows = await events(ids.rel);
  expect(rows.map((e) => e.kind)).toEqual(['ASSIGNED', 'CHANGED', 'COMPLETED', 'ASSIGNED', 'CLEARED']);
  expect(rows.every((e) => e.actorId === ids.rep)).toBe(true);

  // A follow-up is not a contact: nothing was written to the interaction log.
  expect(await prisma.interactionLog.count({ where: { relationId: ids.rel } })).toBe(0);

  // The lead page shows the lines, as system rows.
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await page.getByTestId('sales-lead-interactions-toggle').click();
  const system = page.getByTestId('sales-lead-system-row');
  await expect(system).toHaveCount(5);
  await expect(system.first()).toContainText('Follow-up removed');
  await expect(page.getByTestId('sales-lead-interactions')).toContainText('Follow-up completed');
  await expect(page.getByTestId('sales-lead-interactions')).toContainText(`Call about pricing ${STAMP}`);
  await expect(page.getByTestId('sales-lead-interaction-row')).toHaveCount(0);
});

test('a hand-off is one line on the record the new owner gets', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  const res = await page.request.post(`/api/sales/leads/${ids.rel}/handoff`, {
    data: { toUserId: ids.colleague, action: 'call', note: `Ask for the decision ${STAMP}` },
  });
  expect(res.ok()).toBe(true);
  const { relationId } = (await res.json()) as { relationId: string };

  // One line for the click, not "handed off" plus "follow-up set". (A record
  // with no interactions is corrected in place, so its earlier lines stay on it.)
  const rows = (await events(relationId)).filter((e) => e.kind === 'HANDED_OFF' || e.toUserId === null && e.kind === 'ASSIGNED' && e.toNote?.includes('decision'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'HANDED_OFF', actorId: ids.rep, fromUserId: ids.rep, toUserId: ids.colleague });
  expect(rows[0].toNote).toContain(`Ask for the decision ${STAMP}`);

  await page.context().clearCookies();
  await signInAndSettle(page, emails[1], PW, '/sales');
  await gotoSettled(page, `/sales/leads/${relationId}`);
  const line = page.getByTestId('sales-lead-system-row').first();
  await expect(line).toContainText(`Handed over: ${names.rep} → ${names.colleague}`);
  await expect(line).toContainText(`Ask for the decision ${STAMP}`);
});
