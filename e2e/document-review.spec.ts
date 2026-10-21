import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { missingRequirementsForUser } from '../src/lib/documentRequirements';
import { expireDocuments } from '../src/lib/documentReviewStore';

// The document review chain (#1859): NONE stays "a file attached is done";
// SINGLE / CHAIN leave the requirement open until the steps approve in order;
// an external reviewer decides through an emailed token and reaches nothing
// else; a rejection tells the owner why and re-opens the requirement; an
// approved document past its window expires exactly once and is asked for
// again; the deploy backfill marks pre-chain documents APPROVED, idempotently.

const PW = 'DocReview123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const PDF = Buffer.from('%PDF-1.4\n% e2e document review\n%%EOF\n');
const emails = {
  admin: uniqueEmail('docrev-admin'),
  mentor: uniqueEmail('docrev-mentor'),
  otherMentor: uniqueEmail('docrev-other-mentor'),
  mentee: uniqueEmail('docrev-mentee'),
};
let org: { id: string };
const u: Record<string, { id: string }> = {};
const req: Record<string, string> = {};
let admin: APIRequestContext;
let mentor: APIRequestContext;
let otherMentor: APIRequestContext;
let mentee: APIRequestContext;
let anon: APIRequestContext;
let chainDocId = '';

test.describe.configure({ mode: 'serial' });

async function upload(ctx: APIRequestContext, requirementId: string, name: string) {
  const res = await ctx.post('/api/documents', {
    multipart: { file: { name, mimeType: 'application/pdf', buffer: PDF }, requirementId, title: name },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).document as { id: string; reviewStatus: string; validUntil: string | null };
}

const missingKeys = async () => (await missingRequirementsForUser(u.mentee.id, 'en')).map((r) => r.key);

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `DocRev Org ${stamp}`, slug: `docrev-${stamp}` }, select: { id: true } });
  const mk = (email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') =>
    prisma.user.create({ data: { email, password: hash, role, orgId: org.id, fullName: email.split('@')[0], skills: [], preferredLanguage: 'en', ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}) }, select: { id: true } });
  u.admin = await mk(emails.admin, 'ADMIN');
  u.mentor = await mk(emails.mentor, 'MENTOR');
  u.otherMentor = await mk(emails.otherMentor, 'MENTOR');
  u.mentee = await mk(emails.mentee, 'MENTEE');
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: u.mentor.id, menteeId: u.mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' } });
  const mkReq = (key: string, extra: Record<string, unknown>) =>
    prisma.documentRequirement.create({
      data: { orgId: org.id, key: `${key}-${stamp}`, labels: { en: `${key} doc`, tr: `${key} belge`, de: `${key} Dokument` }, appliesToRole: 'MENTEE', mandatory: true, ...extra },
      select: { id: true },
    });
  req.none = (await mkReq('none', {})).id;
  req.single = (await mkReq('single', { approvalMode: 'SINGLE', reviewerRoles: [{ step: 1, role: 'ADMIN' }] })).id;
  req.chain = (await mkReq('chain', { approvalMode: 'CHAIN', validityDays: 30, reviewerRoles: [{ step: 1, role: 'MENTOR' }, { step: 2, role: 'ADMIN' }, { step: 3, role: 'EXTERNAL', label: 'Supervisor' }] })).id;

  const baseURL = info.project.use.baseURL;
  [admin, mentor, otherMentor, mentee, anon] = await Promise.all([1, 2, 3, 4, 5].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(mentor, emails.mentor, PW)).ok).toBe(true);
  expect((await signInViaApi(otherMentor, emails.otherMentor, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, emails.mentee, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, mentor, otherMentor, mentee, anon].map((c) => c?.dispose()));
  const userIds = Object.values(u).map((x) => x.id);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.document.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => {});
  await prisma.documentRequirement.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
});

test('NONE behaves exactly as before: an upload completes the requirement', async () => {
  expect(await missingKeys()).toContain(`none-${stamp}`);
  const doc = await upload(mentee, req.none, 'none.pdf');
  expect(doc.reviewStatus).toBe('APPROVED');
  expect(await prisma.documentReview.count({ where: { documentId: doc.id } })).toBe(0);
  expect(await missingKeys()).not.toContain(`none-${stamp}`);
});

test('a chain is decided in order, by the right people, and an external reviewer approves through the token alone', { tag: '@smoke' }, async () => {
  const doc = await upload(mentee, req.chain, 'chain.pdf');
  chainDocId = doc.id;
  expect(doc.reviewStatus).toBe('PENDING');
  expect(await prisma.documentReview.count({ where: { documentId: doc.id, orgId: org.id } })).toBe(3);
  // Attached is not done.
  expect(await missingKeys()).toContain(`chain-${stamp}`);

  const url = `/api/documents/${doc.id}/review`;
  // Step 2 before step 1 is refused, whoever asks.
  expect((await admin.post(url, { data: { step: 2, decision: 'APPROVED' } })).status()).toBe(409);
  // Step 1 is the mentor's: not an admin's, not another mentor's, never the owner's.
  expect((await admin.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(403);
  expect((await otherMentor.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(403);
  expect((await mentee.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(403);
  const s1 = await mentor.post(url, { data: { step: 1, decision: 'APPROVED' } });
  expect(s1.status()).toBe(200);
  expect((await s1.json()).reviewStatus).toBe('PENDING');
  // A double submit of the same step is a conflict, not a second decision.
  expect((await mentor.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(409);
  expect((await admin.post(url, { data: { step: 2, decision: 'APPROVED' } })).status()).toBe(200);

  // Step 3 is EXTERNAL: no signed-in decision, the admin's queue offers the link instead.
  expect((await admin.post(url, { data: { step: 3, decision: 'APPROVED' } })).status()).toBe(403);
  const queue = (await (await admin.get('/api/document-reviews')).json()).items as { documentId: string; reviewerRole: string; step: number }[];
  expect(queue.find((i) => i.documentId === doc.id)).toMatchObject({ reviewerRole: 'EXTERNAL', step: 3 });
  // The owner may not name their own reviewer.
  expect((await mentee.post(`${url}/invite`, { data: { email: 'me@example.test' } })).status()).toBe(403);
  expect((await admin.post(`${url}/invite`, { data: { email: 'Supervisor@Example.test' } })).status()).toBe(200);
  const row = await prisma.documentReview.findUniqueOrThrow({ where: { documentId_step: { documentId: doc.id, step: 3 } } });
  expect(row.reviewerEmail).toBe('supervisor@example.test');
  const token = row.reviewToken!;
  expect(token).toMatch(/^[a-f0-9]{48}$/);

  // The token opens this one document and nothing else.
  const view = await anon.get(`/api/document-review/${token}`);
  expect(view.status()).toBe(200);
  expect(await view.json()).toMatchObject({ step: 3, steps: 3, title: 'chain.pdf' });
  expect((await anon.get(`/api/document-review/${token}/file`)).status()).toBe(200);
  expect((await anon.get(`/api/documents/${doc.id}`)).status()).toBe(401);
  expect((await anon.get(`/api/document-review/${'0'.repeat(48)}`)).status()).toBe(404);
  const approved = await anon.post(`/api/document-review/${token}`, { data: { step: 3, decision: 'APPROVED' } });
  expect(approved.status()).toBe(200);
  expect((await approved.json()).reviewStatus).toBe('APPROVED');

  const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
  expect(after.reviewStatus).toBe('APPROVED');
  const days = (after.validUntil!.getTime() - after.validFrom!.getTime()) / 86_400_000;
  expect(Math.round(days)).toBe(30);
  // Spent: the link works once.
  expect((await prisma.documentReview.findUniqueOrThrow({ where: { id: row.id } })).reviewToken).toBeNull();
  expect((await anon.get(`/api/document-review/${token}`)).status()).toBe(404);
  expect((await anon.post(`/api/document-review/${token}`, { data: { step: 3, decision: 'REJECTED', note: 'x' } })).status()).toBe(404);
  expect(await missingKeys()).not.toContain(`chain-${stamp}`);
  expect(await prisma.notification.count({ where: { userId: u.mentee.id, type: 'document.approved' } })).toBe(1);
});

test('a rejection needs a reason, tells the owner why, and re-opens the requirement', async () => {
  const doc = await upload(mentee, req.single, 'single.pdf');
  const url = `/api/documents/${doc.id}/review`;
  const noReason = await admin.post(url, { data: { step: 1, decision: 'REJECTED' } });
  expect(noReason.status()).toBe(400);
  expect((await noReason.json()).code).toBe('reason_required');
  expect((await admin.post(url, { data: { step: 1, decision: 'REJECTED', note: 'The signature is missing.' } })).status()).toBe(200);
  expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).reviewStatus).toBe('REJECTED');
  expect(await missingKeys()).toContain(`single-${stamp}`);
  const note = await prisma.notification.findFirstOrThrow({ where: { userId: u.mentee.id, type: 'document.rejected' } });
  expect(note.params).toMatchObject({ reason: 'The signature is missing.' });
  // The owner's own list carries the reason.
  const list = (await (await mentee.get('/api/documents')).json()).documents as { id: string; reviewStatus: string; reviews: { note: string }[] }[];
  expect(list.find((d) => d.id === doc.id)).toMatchObject({ reviewStatus: 'REJECTED', reviews: [{ note: 'The signature is missing.' }] });
  // Decided is decided.
  expect((await admin.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(409);
});

test('an approved document past its window expires exactly once and is asked for again', async () => {
  await prisma.document.update({ where: { id: chainDocId }, data: { validUntil: new Date(Date.now() - 60_000) } });
  const first = await expireDocuments();
  expect(first.expired).toBeGreaterThanOrEqual(1);
  expect((await prisma.document.findUniqueOrThrow({ where: { id: chainDocId } })).reviewStatus).toBe('EXPIRED');
  await expireDocuments();
  expect(await prisma.document.count({ where: { id: chainDocId, reviewStatus: 'EXPIRED' } })).toBe(1);
  expect(await missingKeys()).toContain(`chain-${stamp}`);
  expect(await prisma.notification.count({ where: { userId: u.mentee.id, type: 'document.expired' } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: u.admin.id, type: 'document.expired.admin' } })).toBe(1);
});

test('the deploy backfill marks pre-chain documents APPROVED and leaves a real chain alone; a second run updates nothing', async () => {
  const legacy = await prisma.document.create({
    data: { ownerId: u.mentee.id, uploaderId: u.mentee.id, title: 'legacy.pdf', filename: 'legacy.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF, requirementId: req.none },
    select: { id: true, reviewStatus: true },
  });
  expect(legacy.reviewStatus).toBe('PENDING');
  const waiting = await upload(mentee, req.single, 'waiting.pdf');
  const run = () => execFileSync('node', ['prisma/backfill-document-reviews.mjs'], { encoding: 'utf8' });
  expect(run()).toMatch(/updated=[1-9]/);
  expect((await prisma.document.findUniqueOrThrow({ where: { id: legacy.id } })).reviewStatus).toBe('APPROVED');
  expect((await prisma.document.findUniqueOrThrow({ where: { id: waiting.id } })).reviewStatus).toBe('PENDING');
  expect(run()).toContain('updated=0');
});

test('the external reviewer\'s page decides through the link and then says it is spent', async ({ page }) => {
  const doc = await upload(mentee, req.chain, 'renewal.pdf');
  const url = `/api/documents/${doc.id}/review`;
  expect((await mentor.post(url, { data: { step: 1, decision: 'APPROVED' } })).status()).toBe(200);
  expect((await admin.post(url, { data: { step: 2, decision: 'APPROVED' } })).status()).toBe(200);
  expect((await mentor.post(`${url}/invite`, { data: { email: 'supervisor2@example.test' } })).status()).toBe(200);
  const token = (await prisma.documentReview.findUniqueOrThrow({ where: { documentId_step: { documentId: doc.id, step: 3 } } })).reviewToken!;

  await gotoSettled(page, `/document-review/${token}`);
  await page.getByTestId('document-review-token-reject').click();
  await expect(page.getByText('Give a reason — it is what the person is told.')).toBeVisible(); // a reason first
  await page.getByTestId('document-review-token-note').fill('Wrong period.');
  await page.getByTestId('document-review-token-reject').click();
  await expect(page.getByTestId('document-review-done')).toBeVisible();
  expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).reviewStatus).toBe('REJECTED');
  await page.reload();
  await expect(page.getByTestId('document-review-gone')).toBeVisible();
});
