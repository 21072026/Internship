import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * After a call, one answer and at most one record (#3904):
 *   - "Reached" with a note on a lead whose open follow-up is a call: one Call
 *     interaction carrying the note, and the follow-up completed (cleared, its
 *     history says COMPLETED) — no second interaction from "Complete".
 *   - "Reached" on a lead whose follow-up is an e-mail: "Complete" starts
 *     unticked, and a next step can be set in the same save.
 *   - "Not reached": an attempt; the follow-up stays and "Tomorrow" moves it,
 *     keeping its step and words.
 *   - "Didn't call": nothing.
 * SYNTHETIC ONLY.
 */

const PW = 'CallOutcome3904!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const repEmail = uniqueEmail(`co-rep-${STAMP}`);
let orgId = '';
const rel: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'Europe/Berlin', locale: 'en-GB' });

function berlinDay(offset: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + offset * 24 * 3600 * 1000),
  );
}

async function lead(key: string, phone: string, followUp: { type: string; note: string }) {
  const company = await prisma.company.create({ data: { orgId, name: `Example ${key} ${STAMP}`, contactName: `Contact ${key}`, contactPhone: phone } });
  const user = await prisma.user.create({
    data: { orgId, email: `co-${key}-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Contact ${key}`, phone, skills: [], companyId: company.id },
  });
  const rep = await prisma.user.findFirstOrThrow({ where: { email: repEmail }, select: { id: true } });
  rel[key] = (await prisma.mentorshipRelation.create({
    data: {
      orgId, mentorId: rep.id, menteeId: user.id, companyId: company.id, pipelineStatus: 'LEAD_CONTACTED',
      nextActionAt: new Date(`${berlinDay(0)}T00:00:00.000Z`), nextActionType: followUp.type, nextActionNote: followUp.note,
    },
  })).id;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Call Outcome ${STAMP}`, slug: `co-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })) });
  await seedUser(repEmail, PW, 'MENTOR', `CO Rep ${STAMP}`, orgId);
  await lead('call', '+49 30 1000001', { type: 'call', note: 'Ask about the budget' });
  await lead('email', '+49 30 1000002', { type: 'email', note: 'Send the brochure' });
  await lead('miss', '+49 30 1000003', { type: 'call', note: 'Second try' });
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  await cleanupByEmail(repEmail);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function openLeadAndCall(page: Page, key: string) {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, repEmail, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${rel[key]}`);
  await page.evaluate(() =>
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a[href^="tel:"]')) e.preventDefault();
    }, true),
  );
  await page.getByTestId('sales-lead-phone-link').click();
}

const followUpOf = (id: string) =>
  prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: { nextActionAt: true, nextActionNote: true, nextActionType: true, nextActionTime: true } });

test('Reached with a note on a call follow-up: one interaction, and the follow-up is completed', async ({ page }) => {
  await openLeadAndCall(page, 'call');
  await page.getByTestId('contact-reached-yes').click();
  await expect(page.getByTestId('contact-reached-complete')).toBeChecked();
  await page.getByTestId('contact-reached-note').fill(`Discussed the budget ${STAMP}`);
  await page.getByTestId('contact-reached-save').click();

  await expect.poll(async () => (await followUpOf(rel.call)).nextActionAt).toBeNull();
  const logs = await prisma.interactionLog.findMany({ where: { relationId: rel.call } });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ type: 'Call', outcome: 'REACHED', notes: `Discussed the budget ${STAMP}` });
  const f = await followUpOf(rel.call);
  expect(f.nextActionNote).toBeNull();
  expect(f.nextActionType).toBeNull();
  const event = await prisma.followUpEvent.findFirst({ where: { relationId: rel.call }, orderBy: { createdAt: 'desc' } });
  expect(event?.kind).toBe('COMPLETED');
  await expect(page.getByTestId('follow-up-empty')).toBeVisible();
});

test('Reached on an e-mail follow-up: Complete starts unticked, and a next step is set in the same save', async ({ page }) => {
  await openLeadAndCall(page, 'email');
  await page.getByTestId('contact-reached-yes').click();
  await expect(page.getByTestId('contact-reached-complete')).not.toBeChecked();
  await page.getByTestId('contact-reached-complete').check();
  await page.getByTestId('contact-reached-next').check();
  await page.getByTestId('contact-next-action-meeting').check({ force: true });
  await page.getByTestId('contact-next-quick-3').click();
  await page.getByTestId('contact-next-note').fill('Book the demo date');
  await page.getByTestId('contact-reached-save').click();

  await expect.poll(async () => (await followUpOf(rel.email)).nextActionType).toBe('meeting');
  const f = await followUpOf(rel.email);
  expect(f.nextActionNote).toBe('Book the demo date');
  expect(f.nextActionAt?.toISOString()).toBe(`${berlinDay(3)}T00:00:00.000Z`);
  expect(await prisma.interactionLog.count({ where: { relationId: rel.email } })).toBe(1);
  const kinds = (await prisma.followUpEvent.findMany({ where: { relationId: rel.email }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind);
  expect(kinds).toEqual(['COMPLETED', 'ASSIGNED']);
});

test("Not reached logs an attempt and moves the follow-up; Didn't call writes nothing", async ({ page }) => {
  await openLeadAndCall(page, 'miss');
  await page.getByTestId('contact-reached-no').click();
  await expect(page.getByTestId('contact-retry')).toBeVisible();
  await expect.poll(() => prisma.interactionLog.count({ where: { relationId: rel.miss, outcome: 'NOT_REACHED' } })).toBe(1);
  // The follow-up is still there, then "Tomorrow" moves only its day.
  expect((await followUpOf(rel.miss)).nextActionAt?.toISOString()).toBe(`${berlinDay(0)}T00:00:00.000Z`);
  await page.getByTestId('contact-retry-1').click();
  await expect.poll(async () => (await followUpOf(rel.miss)).nextActionAt?.toISOString()).toBe(`${berlinDay(1)}T00:00:00.000Z`);
  const f = await followUpOf(rel.miss);
  expect(f).toMatchObject({ nextActionType: 'call', nextActionNote: 'Second try' });
  expect(await prisma.interactionLog.count({ where: { relationId: rel.miss, outcome: 'REACHED' } })).toBe(0);

  // "Didn't call": no row at all.
  const before = await prisma.interactionLog.count({ where: { relationId: rel.miss } });
  await page.getByTestId('sales-lead-phone-link').click();
  await page.getByTestId('contact-reached-skip').click();
  await expect(page.getByTestId('contact-reached')).toHaveCount(0);
  expect(await prisma.interactionLog.count({ where: { relationId: rel.miss } })).toBe(before);
});
