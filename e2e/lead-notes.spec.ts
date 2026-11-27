import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static import: Playwright resolves the `@/…` alias in the spec's import graph only.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * A free note on a sales record (#3978): POST /api/sales/leads/[id]/notes.
 *
 * The owner, and anyone who owned the lead before and handed it on (a
 * HANDED_OFF line naming them, or an earlier period of the chain), may add one;
 * a teammate who merely reads the record gets the same 404 as a missing id. A
 * note is one NOTE line in the history with its author — never an
 * InteractionLog row, so never a contact. A colleague's note rings the owner;
 * the owner's own does not. A double click is one note.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'LeadNotes3978!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
let orgId = '';
let otherOrgId = '';
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } };

async function as(playwright: RequestFactory, baseURL: string | undefined, who: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
  contexts.push(ctx);
  const res = await signInViaApi(ctx, emails[who], PW, { host: MARKETING_HOST, headers: freshIp(`lead-notes-${who}`) });
  expect(res.error, `sign-in ${who}`).toBeNull();
  return ctx;
}

const note = (ctx: APIRequestContext, relationId: string, text: unknown) =>
  ctx.post(`/api/sales/leads/${relationId}/notes`, { headers: host, data: { text } });

async function person(key: string, role: 'MENTOR' | 'ADMIN', org: string) {
  emails[key] = uniqueEmail(`ln-${key}-${STAMP}`);
  ids[key] = (await seedUser(emails[key], PW, role, `LN ${key} ${STAMP}`, org)).id;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Notes ${STAMP}`, slug: `ln-${STAMP}`, vertical: 'MARKETING' } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Acme Other ${STAMP}`, slug: `ln-o-${STAMP}`, vertical: 'MARKETING' } })).id;
  for (const o of [orgId, otherOrgId]) {
    await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: o })) });
  }
  await person('owner', 'MENTOR', orgId);
  await person('handedFrom', 'MENTOR', orgId); // handed it to the owner in place
  await person('earlier', 'MENTOR', orgId); // owned an earlier period of the chain
  await person('teammate', 'MENTOR', orgId); // reads the team book, never owned it
  await person('foreign', 'ADMIN', otherOrgId);
  const lead = await prisma.user.create({
    data: { orgId, email: `ln-lead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Contact LN ${STAMP}`, skills: [] },
  });
  const earlierRel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ids.earlier, menteeId: lead.id, status: 'COMPLETED', pipelineStatus: 'LEAD_CONTACTED', completedAt: new Date() },
  });
  ids.rel = (await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ids.owner, menteeId: lead.id, pipelineStatus: 'LEAD_CONTACTED', previousRelationId: earlierRel.id },
  })).id;
  await prisma.followUpEvent.create({
    data: { relationId: ids.rel, kind: 'HANDED_OFF', fromUserId: ids.handedFrom, toUserId: ids.owner, actorId: ids.handedFrom, dedupeKey: `seed-${STAMP}` },
  });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const o of [orgId, otherOrgId]) {
    await prisma.followUpEvent.deleteMany({ where: { relation: { orgId: o } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: o } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: o, role: 'MENTEE' } }).catch(() => {});
  }
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  for (const o of [orgId, otherOrgId]) {
    await prisma.pipelineStage.deleteMany({ where: { orgId: o } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: o } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const notesOn = () => prisma.followUpEvent.findMany({ where: { relationId: ids.rel, kind: 'NOTE' }, orderBy: { createdAt: 'asc' } });
const bells = () => prisma.notification.count({ where: { userId: ids.owner, type: 'lead.noteAdded' } });

test('who may note a lead, and what a note is (never a contact)', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, 'owner');

  // The owner's own note: saved, nobody rung; a double click is one note.
  const [a, b] = await Promise.all([note(owner, ids.rel, '  Budget approved  '), note(owner, ids.rel, 'Budget approved')]);
  expect([a.status(), b.status()]).toEqual([201, 201]);
  expect((await a.json()).notified).toBe(false);
  expect((await notesOn()).map((n) => [n.toNote, n.actorId])).toEqual([['Budget approved', ids.owner]]);
  expect(await bells()).toBe(0);
  // Not a contact: no InteractionLog row.
  expect(await prisma.interactionLog.count({ where: { relationId: ids.rel } })).toBe(0);

  // The colleague who handed it over: saved, and the owner hears it.
  const handedFrom = await as(playwright, baseURL, 'handedFrom');
  const fromRes = await note(handedFrom, ids.rel, 'They called me back: offer next week');
  expect(fromRes.status()).toBe(201);
  expect((await fromRes.json()).notified).toBe(true);
  await expect.poll(bells).toBe(1);
  const bell = await prisma.notification.findFirstOrThrow({ where: { userId: ids.owner, type: 'lead.noteAdded' } });
  expect(bell.link).toBe(`/sales/leads/${ids.rel}`);

  // The owner of an earlier period of the same lead may too.
  const earlier = await as(playwright, baseURL, 'earlier');
  expect((await note(earlier, ids.rel, 'Prefers e-mail')).status()).toBe(201);

  // A teammate who only reads it, and another org: the 404 of a missing id.
  const teammate = await as(playwright, baseURL, 'teammate');
  const refused = await note(teammate, ids.rel, 'Not mine');
  expect(refused.status()).toBe(404);
  expect((await refused.json()).code).toBe('missing');
  const foreign = await as(playwright, baseURL, 'foreign');
  expect((await note(foreign, ids.rel, 'Elsewhere')).status()).toBe(404);
  expect((await note(owner, 'no-such-id', 'x')).status()).toBe(404);

  // The shape: empty and too long are refused.
  expect((await (await note(owner, ids.rel, '   ')).json()).code).toBe('empty');
  const long = await note(owner, ids.rel, 'x'.repeat(281));
  expect(long.status()).toBe(400);
  expect((await long.json()).code).toBe('too_long');

  expect((await notesOn()).map((n) => n.actorId)).toEqual([ids.owner, ids.handedFrom, ids.earlier]);
  // The record itself is untouched: same owner, no follow-up.
  const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ids.rel }, select: { mentorId: true, nextActionAt: true } });
  expect(rel).toEqual({ mentorId: ids.owner, nextActionAt: null });
});

test('the previous owner adds a note on the lead page and reads it in the history', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.handedFrom, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await page.getByTestId('sales-lead-note-open').click();
  const text = `New contact person since today ${STAMP}`;
  await page.getByTestId('sales-lead-note-input').fill(text);
  await expect(page.getByTestId('sales-lead-note-count')).toContainText(`${text.length}/280`);
  await page.getByTestId('sales-lead-note-save').click();
  await expect(page.getByTestId('sales-lead-note-text').filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
  // The colleague's own earlier note is in the history too, with its author.
  await expect(page.getByTestId('sales-lead-note-row').filter({ hasText: 'They called me back' })).toContainText(`LN handedFrom ${STAMP}`);

  // A teammate who only reads the record is offered no note.
  await page.context().clearCookies();
  await signInAndSettle(page, emails.teammate, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.rel}`);
  await expect(page.getByTestId('sales-lead-interactions-card')).toBeVisible();
  await expect(page.getByTestId('sales-lead-note-open')).toHaveCount(0);
});
