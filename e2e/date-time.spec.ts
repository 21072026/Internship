import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Date AND time (#3901). An interaction is an instant: the log form takes date
// + time in the rep's zone, so two logs of one day list in the order they
// happened, while a log stored as a bare day (UTC midnight) reads as its day —
// never as an invented "01:00". A follow-up stays a DAY with an optional wall
// time beside it: the panel, the PUT and the hand-off carry it, and clearing
// the day clears it. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });
// A zone east of UTC: the one where a bare day used to read "01:00".
test.use({ timezoneId: 'Europe/Berlin', locale: 'en-GB' });

const PW = 'DateTime3901Pass!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`dt-${label}-${STAMP}`);
  emails.push(email);
  ids[label] = (await seedUser(email, PW, role, `DT ${label} ${STAMP}`, orgId)).id;
  return email;
}

/** Today in Berlin as YYYY-MM-DD — what the browser's datetime-local starts from. */
function berlinToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales DT ${STAMP}`, slug: `dt-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  await person('rep', 'MENTOR');
  await person('rep2', 'MENTOR');
  await person('lead', 'MENTEE');
  await person('lead2', 'MENTEE');
  ids.rel = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
  ids.rel2 = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: ids.lead2, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('logs typed at 10:00 and 15:00 list in that order, with their times; a bare day shows no time', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  // An older log stored as a bare day (UTC midnight) — what every row before #3901 is.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dayOnly = await page.request.post('/api/interactions', {
    data: { relationId: ids.rel, date: yesterday, type: 'Call', notes: `Day only ${STAMP}` },
  });
  expect(dayOnly.ok()).toBe(true);
  const stored = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: ids.rel, notes: `Day only ${STAMP}` } });
  expect(stored.date.toISOString()).toBe(`${yesterday}T00:00:00.000Z`);

  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  const today = berlinToday();
  // The later one first, as a rep catching up would: the list orders by the time, not the typing.
  for (const [time, text] of [['15:00', `Afternoon note ${STAMP}`], ['10:00', `Morning call ${STAMP}`]]) {
    await page.getByTestId('interaction-form-open').first().click();
    await page.getByTestId('interaction-form-date').fill(`${today}T${time}`);
    await page.getByPlaceholder(/notes/i).last().fill(text);
    await page.getByRole('button', { name: /log interaction/i }).last().click();
    // The row, not the card: the card also holds the open form's textarea.
    await expect(page.getByTestId('sales-lead-interaction-row').filter({ hasText: text })).toHaveCount(1);
  }

  // Stored as the instant typed in Berlin.
  const morning = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: ids.rel, notes: `Morning call ${STAMP}` } });
  const offsetH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(`${today}T12:00:00Z`))) - 12;
  expect(morning.date.toISOString()).toBe(new Date(`${today}T${String(10 - offsetH).padStart(2, '0')}:00:00.000Z`).toISOString());

  const rows = page.getByTestId('sales-lead-interaction-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`Afternoon note ${STAMP}`);
  await expect(rows.nth(0)).toContainText('15:00');
  await expect(rows.nth(1)).toContainText(`Morning call ${STAMP}`);
  await expect(rows.nth(1)).toContainText('10:00');
  await expect(rows.nth(2)).toContainText(`Day only ${STAMP}`);
  await expect(rows.nth(2).locator('time')).not.toContainText(':');
});

test('a follow-up takes an optional time: shown beside the day, kept by a day-only edit, cleared with the day', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');
  const put = (data: Record<string, unknown>) => page.request.put(`/api/mentorship/${ids.rel}`, { data });
  const row = () =>
    prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.rel }, select: { nextActionAt: true, nextActionTime: true, nextActionRemindedAt: true } });

  // Through the panel.
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await page.getByTestId('follow-up-add').click();
  await page.getByTestId('follow-up-date').fill('2026-12-10');
  await page.getByTestId('follow-up-time').fill('14:30');
  await page.getByTestId('follow-up-note').fill(`Call back ${STAMP}`);
  await page.getByTestId('follow-up-save').click();
  await expect(page.getByTestId('follow-up-read-time')).toHaveText(' · 14:30');
  let r = await row();
  expect(r.nextActionAt?.toISOString()).toBe('2026-12-10T00:00:00.000Z');
  expect(r.nextActionTime).toBe('14:30');

  // A changed time on the same day keeps the reminder already sent for it.
  await prisma.mentorshipRelation.update({ where: { id: ids.rel }, data: { nextActionRemindedAt: new Date() } });
  expect((await put({ nextActionTime: '09:15' })).ok()).toBe(true);
  r = await row();
  expect(r.nextActionTime).toBe('09:15');
  expect(r.nextActionRemindedAt).not.toBeNull();
  // A request that does not send the time leaves it.
  expect((await put({ nextActionAt: '2026-12-11' })).ok()).toBe(true);
  expect((await row()).nextActionTime).toBe('09:15');
  // A bad time is refused before anything is written.
  const bad = await put({ nextActionTime: '25:00' });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).code).toBe('invalid_time');
  // Clearing the day clears its time.
  expect((await put({ nextActionAt: null, nextActionNote: null, nextActionCompleted: true })).ok()).toBe(true);
  r = await row();
  expect(r.nextActionAt).toBeNull();
  expect(r.nextActionTime).toBeNull();
});

test('a hand-off carries the time it is given, and "keep the follow-up" keeps the time', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[0], PW, '/sales');

  const res = await page.request.post(`/api/sales/leads/${ids.rel2}/handoff`, {
    data: { toUserId: ids.rep2, action: 'call', dueOn: '2026-12-12', dueAt: '11:00' },
  });
  expect(res.ok()).toBe(true);
  const newId = (await res.json()).relationId as string;
  const handed = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: newId }, select: { nextActionAt: true, nextActionTime: true } });
  expect(handed.nextActionAt?.toISOString()).toBe('2026-12-12T00:00:00.000Z');
  expect(handed.nextActionTime).toBe('11:00');

  // The new owner hands it back, keeping that step: the time travels with it.
  const ctx = await page.context().browser()!.newContext({ extraHTTPHeaders: H, timezoneId: 'Europe/Berlin' });
  const rep2Page = await ctx.newPage();
  await signInAndSettle(rep2Page, emails[1], PW, '/sales');
  const kept = await rep2Page.request.post(`/api/sales/leads/${newId}/handoff`, { data: { toUserId: ids.rep, action: 'call', keepFollowUp: true } });
  expect(kept.ok()).toBe(true);
  const keptId = (await kept.json()).relationId as string;
  const keptRow = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: keptId }, select: { nextActionAt: true, nextActionTime: true } });
  expect(keptRow.nextActionAt?.toISOString()).toBe('2026-12-12T00:00:00.000Z');
  expect(keptRow.nextActionTime).toBe('11:00');
  await ctx.close();

  const badTime = await page.request.post(`/api/sales/leads/${ids.rel}/handoff`, {
    data: { toUserId: ids.rep2, action: 'call', dueAt: '7pm' },
  });
  expect(badTime.status()).toBe(400);
  expect((await badTime.json()).code).toBe('invalid_time');
});
