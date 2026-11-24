import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// What a follow-up IS (#3900): MentorshipRelation.nextActionType is the hand-off's
// pick, or what the note's label says on an owner's edit, cleared with the step,
// kept with a kept step — and the deploy backfill fills it for older rows from
// the same reading. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'NextActionType123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
let orgId = '';
let admin: APIRequestContext;
let rep2: APIRequestContext;

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`nat-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `NAT ${label} ${STAMP}`, orgId);
  ids[label] = user.id;
  mail[label] = email;
  return user.id;
}

async function lead(label: string, ownerId: string, extra: Record<string, unknown> = {}) {
  const menteeId = await person(`lead-${label}`, 'MENTEE');
  const rel = await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId, pipelineStatus: 'LEAD_QUALIFIED', ...extra } });
  ids[`rel-${label}`] = rel.id;
  return rel.id;
}

const typeOf = async (id: string) =>
  (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: { nextActionType: true } })).nextActionType;

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales NAT ${STAMP}`, slug: `nat-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  await person('admin', 'ADMIN');
  await person('rep1', 'MENTOR');
  await person('rep2', 'MENTOR');
  admin = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  expect((await signInViaApi(admin, mail.admin, PW, { host: MARKETING_HOST, headers: freshIp('nat-admin') })).error).toBeNull();
  rep2 = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  expect((await signInViaApi(rep2, mail.rep2, PW, { host: MARKETING_HOST, headers: freshIp('nat-rep2') })).error).toBeNull();
});

test.afterAll(async () => {
  await admin?.dispose();
  await rep2?.dispose();
  const userIds = Object.entries(ids).filter(([k]) => !k.startsWith('rel-') && !k.startsWith('new-')).map(([, v]) => v);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a hand-off stores its pick on the record the recipient now owns', async () => {
  await lead('handed', ids.rep1);
  const res = await admin.post(`/api/sales/leads/${ids['rel-handed']}/handoff`, { data: { toUserId: ids.rep2, action: 'email', note: `Send the offer ${STAMP}` } });
  expect(res.status(), await res.text()).toBe(200);
  ids['new-handed'] = (await res.json()).relationId;
  expect(await typeOf(ids['new-handed'])).toBe('email');
});

test('an owner\'s edit: a sent pick wins, else the note\'s label, else none; completing clears it', async () => {
  const id = ids['new-handed'];
  const patch = (data: Record<string, unknown>) => rep2.put(`/api/mentorship/${id}`, { data });

  // A note in another language's label, no pick sent: read from the label.
  expect((await patch({ nextActionNote: 'Telefonla aranacak: ilk tanışma' })).status()).toBe(200);
  expect(await typeOf(id)).toBe('call');
  // Only the day moves: what the step is stays.
  expect((await patch({ nextActionAt: '2026-12-01' })).status()).toBe(200);
  expect(await typeOf(id)).toBe('call');
  // The pick sent with a free-text note wins.
  expect((await patch({ nextActionNote: 'show them the app', nextActionType: 'demo' })).status()).toBe(200);
  expect(await typeOf(id)).toBe('demo');
  // Free text, no pick: not stated.
  expect((await patch({ nextActionNote: 'ring back after lunch' })).status()).toBe(200);
  expect(await typeOf(id)).toBeNull();
  // Not a pick: refused, nothing written.
  expect((await patch({ nextActionNote: 'x', nextActionType: 'fax' })).status()).toBe(400);
  expect(await typeOf(id)).toBeNull();
  // Complete clears the day, the note and what it was.
  expect((await patch({ nextActionNote: 'E-Mail senden', nextActionAt: '2026-12-02' })).status()).toBe(200);
  expect(await typeOf(id)).toBe('email');
  expect((await patch({ nextActionAt: '', nextActionNote: '', nextActionCompleted: true })).status()).toBe(200);
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: { nextActionAt: true, nextActionNote: true, nextActionType: true } });
  expect(row).toEqual({ nextActionAt: null, nextActionNote: null, nextActionType: null });
});

test('a hand-off that keeps the follow-up keeps what it is — read from the note on an older row', async () => {
  // An older row: a composed note and no type, as before the column existed.
  await lead('kept', ids.rep1, { nextActionAt: new Date('2026-12-03T00:00:00Z'), nextActionNote: 'Termin vereinbaren: nächste Woche' });
  const res = await admin.post(`/api/sales/leads/${ids['rel-kept']}/handoff`, { data: { toUserId: ids.rep2, action: 'call', keepFollowUp: true } });
  expect(res.status(), await res.text()).toBe(200);
  const id = (await res.json()).relationId;
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: { nextActionNote: true, nextActionType: true } });
  expect(row).toEqual({ nextActionNote: 'Termin vereinbaren: nächste Woche', nextActionType: 'meeting' });
});

test('the deploy backfill types older rows from their label, leaves free text and set types alone, and converges', async () => {
  await lead('old-call', ids.rep1, { nextActionNote: 'Anrufen: Preis klären' });
  await lead('old-free', ids.rep1, { nextActionNote: `whatever ${STAMP}` });
  await lead('old-set', ids.rep1, { nextActionNote: 'Call: x', nextActionType: 'other' });
  const run = () => execFileSync('node', ['prisma/backfill-next-action-type.mjs', '--apply'], { env: process.env, encoding: 'utf8' });
  expect(run()).toMatch(/filled=\d+/);
  expect(await typeOf(ids['rel-old-call'])).toBe('call');
  expect(await typeOf(ids['rel-old-free'])).toBeNull();
  expect(await typeOf(ids['rel-old-set'])).toBe('other');
  // A second run finds nothing more to fill for these rows.
  run();
  expect(await typeOf(ids['rel-old-call'])).toBe('call');
  expect(await typeOf(ids['rel-old-free'])).toBeNull();
});
