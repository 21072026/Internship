import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Images on a follow-up (#3931). Uploaded as a draft, attached by the follow-up
// write that names it, cleared with the follow-up, carried by a kept hand-off.
// Read by whoever reads the follow-up note (owner, admin) — never another rep,
// the lead or another org: all of them get the same 404. Only real images.
// SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'FollowUpImg3931!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
const orgIds: string[] = [];

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  emails[label] = uniqueEmail(`fui-${label}-${STAMP}`);
  ids[label] = (await seedUser(emails[label], PW, role, `FUI ${label} ${STAMP}`, orgId)).id;
}

type Pw = { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } };
async function as(playwright: Pw, baseURL: string | undefined, label: string): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  const res = await signInViaApi(ctx, emails[label], PW, { host: MARKETING_HOST });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

const upload = (api: APIRequestContext, relationId: string, buffer: Buffer, name = 'shot.png', mimeType = 'image/png') =>
  api.post(`/api/mentorship/${relationId}/follow-up-images`, { multipart: { file: { name, mimeType, buffer } } });

test.beforeAll(async () => {
  for (const slug of ['a', 'b']) {
    const org = await prisma.organization.create({ data: { name: `Acme Sales FUI ${slug} ${STAMP}`, slug: `fui-${slug}-${STAMP}`, vertical: 'MARKETING' } });
    orgIds.push(org.id);
    await prisma.pipelineStage.createMany({
      data: templateStagePayload(defaultTemplateForVertical('MARKETING')!, 'en').stages.map((st) => ({
        orgId: org.id, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
      })),
    });
  }
  await person('rep', 'MENTOR', orgIds[0]);
  await person('rep2', 'MENTOR', orgIds[0]);
  await person('admin', 'ADMIN', orgIds[0]);
  await person('lead', 'MENTEE', orgIds[0]);
  await person('lead2', 'MENTEE', orgIds[0]);
  await person('foreignAdmin', 'ADMIN', orgIds[1]);
  ids.rel = (await prisma.mentorshipRelation.create({ data: { orgId: orgIds[0], mentorId: ids.rep, menteeId: ids.lead, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
  ids.rel2 = (await prisma.mentorshipRelation.create({ data: { orgId: orgIds[0], mentorId: ids.rep, menteeId: ids.lead2, pipelineStatus: 'LEAD_QUALIFIED' } })).id;
});

test.afterAll(async () => {
  await prisma.followUpImage.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId: { in: orgIds } }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('the owner uploads a draft and attaches it; owner and admin read it, nobody else does', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.slow();
  const rep = await as(playwright, baseURL, 'rep');

  // Only a real image: a PDF named .png is refused.
  const notImage = await upload(rep, ids.rel, Buffer.from('%PDF-1.7 not an image'), 'fake.png');
  expect(notImage.status()).toBe(400);
  expect((await notImage.json()).code).toBe('not_an_image');

  const up = await upload(rep, ids.rel, PNG);
  expect(up.status()).toBe(201);
  const draftId = (await up.json()).image.id as string;
  // A draft is not on the follow-up yet.
  expect((await (await rep.get(`/api/mentorship/${ids.rel}/follow-up-images`)).json()).current).toEqual([]);

  const put = await rep.put(`/api/mentorship/${ids.rel}`, {
    data: { nextActionAt: '2026-12-10', nextActionNote: `Look at the screen ${STAMP}`, nextActionImageIds: [draftId] },
  });
  expect(put.ok()).toBe(true);
  const list = await (await rep.get(`/api/mentorship/${ids.rel}/follow-up-images`)).json();
  expect(list.current.map((i: { id: string }) => i.id)).toEqual([draftId]);
  const own = await rep.get(`/api/follow-up-images/${draftId}`);
  expect(own.status()).toBe(200);
  expect(own.headers()['content-type']).toBe('image/png');
  expect(own.headers()['x-content-type-options']).toBe('nosniff');

  const admin = await as(playwright, baseURL, 'admin');
  expect((await admin.get(`/api/follow-up-images/${draftId}`)).status()).toBe(200);

  // Another rep, the lead and another org's admin: the same 404, for the bytes, the list and an upload.
  for (const label of ['rep2', 'lead', 'foreignAdmin']) {
    const p = await as(playwright, baseURL, label);
    expect((await p.get(`/api/follow-up-images/${draftId}`)).status(), label).toBe(404);
    expect((await p.get(`/api/mentorship/${ids.rel}/follow-up-images`)).status(), label).toBe(404);
    expect((await upload(p, ids.rel, PNG)).status(), label).toBe(404);
    await p.dispose();
  }

  // Someone else's draft cannot be attached, even by an admin.
  const adminDraft = (await (await upload(admin, ids.rel, PNG)).json()).image.id as string;
  const steal = await rep.put(`/api/mentorship/${ids.rel}`, { data: { nextActionImageIds: [draftId, adminDraft] } });
  expect(steal.status()).toBe(400);
  expect((await steal.json()).code).toBe('unknown_image');
  // …and nobody but its uploader reads a draft.
  expect((await rep.get(`/api/follow-up-images/${adminDraft}`)).status()).toBe(404);

  // Clearing the follow-up takes the image off it; it stays in the history.
  expect((await rep.put(`/api/mentorship/${ids.rel}`, { data: { nextActionAt: null, nextActionNote: null, nextActionCompleted: true } })).ok()).toBe(true);
  const after = await (await rep.get(`/api/mentorship/${ids.rel}/follow-up-images`)).json();
  expect(after.current).toEqual([]);
  expect(after.history.map((i: { id: string }) => i.id)).toEqual([draftId]);
  await admin.dispose();
  await rep.dispose();
});

test('a kept hand-off carries the images; a new step brings the sender\'s drafts', async ({ playwright, baseURL }) => {
  test.slow();
  const rep = await as(playwright, baseURL, 'rep');
  const first = (await (await upload(rep, ids.rel2, PNG)).json()).image.id as string;
  expect((await rep.put(`/api/mentorship/${ids.rel2}`, { data: { nextActionAt: '2026-12-11', nextActionNote: `Call ${STAMP}`, nextActionImageIds: [first] } })).ok()).toBe(true);

  // Kept: the image travels to the record rep2 now owns.
  const kept = await rep.post(`/api/sales/leads/${ids.rel2}/handoff`, { data: { toUserId: ids.rep2, action: 'call', keepFollowUp: true } });
  expect(kept.ok()).toBe(true);
  const keptId = (await kept.json()).relationId as string;
  const rep2 = await as(playwright, baseURL, 'rep2');
  const onKept = await (await rep2.get(`/api/mentorship/${keptId}/follow-up-images`)).json();
  expect(onKept.current.map((i: { id: string }) => i.id)).toEqual([first]);
  expect((await rep2.get(`/api/follow-up-images/${first}`)).status()).toBe(200);

  // A new step: rep2's draft goes with it to rep; the kept image leaves the follow-up.
  const second = (await (await upload(rep2, keptId, PNG)).json()).image.id as string;
  const back = await rep2.post(`/api/sales/leads/${keptId}/handoff`, { data: { toUserId: ids.rep, action: 'email', note: 'Send the offer', imageIds: [second] } });
  expect(back.ok()).toBe(true);
  const backId = (await back.json()).relationId as string;
  const onBack = await (await rep.get(`/api/mentorship/${backId}/follow-up-images`)).json();
  expect(onBack.current.map((i: { id: string }) => i.id)).toEqual([second]);
  const firstRow = await prisma.followUpImage.findUniqueOrThrow({ where: { id: first }, select: { clearedAt: true } });
  expect(firstRow.clearedAt).not.toBeNull();
  await rep2.dispose();
  await rep.dispose();
});
