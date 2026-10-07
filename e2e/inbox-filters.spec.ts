import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInAsFreshUser, signInViaApi } from './helpers/auth';
import { sendUnreadMessageDigests } from '@/services/emailService';

// Per-viewer inbox state (#1609): pin, archive, mute — and what a mute
// silences (the bell, the e-mail mirror, the unread digest).

// The digest renders HMAC'd links; requireServerSecret() throws when unset
// (#870). Same guard as system-mail-language.spec.ts.
process.env.NEXTAUTH_SECRET ||= 'e2e-inbox-filters-secret';

const PASSWORD = 'InboxState123!';
let pair: SeededRelation;
let quiet: SeededRelation; // a second pair whose mentee mutes the thread
let conversationId = '';
let quietConversationId = '';
let mentee: APIRequestContext;
let mentor: APIRequestContext;
let quietMentee: APIRequestContext;
let quietMentor: APIRequestContext;

async function directConversation(a: string, b: string) {
  return prisma.conversation.create({
    data: { type: 'DIRECT', directKey: [a, b].sort().join('|'), participants: { create: [{ userId: a }, { userId: b }] } },
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  pair = await seedMenteeWithRelation('inbox-state', PASSWORD);
  quiet = await seedMenteeWithRelation('inbox-quiet', PASSWORD);
  conversationId = (await directConversation(pair.mentorId, pair.menteeId)).id;
  quietConversationId = (await directConversation(quiet.mentorId, quiet.menteeId)).id;
  await prisma.message.create({ data: { conversationId, relationId: pair.relationId, senderId: pair.mentorId, body: 'Hello there', readAt: new Date() } });
  const baseURL = info.project.use.baseURL;
  [mentee, mentor, quietMentee, quietMentor] = await Promise.all([1, 2, 3, 4].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(mentee, pair.menteeEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(mentor, pair.mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(quietMentee, quiet.menteeEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(quietMentor, quiet.mentorEmail, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([mentee, mentor, quietMentee, quietMentor].map((c) => c?.dispose()));
  for (const s of [pair, quiet]) {
    if (!s) continue;
    await prisma.emailLog.deleteMany({ where: { to: { in: s.emails } } });
    await cleanupMenteeWithRelation(s);
  }
});

test('the state route writes only your own row, in a thread that opens for you', async ({ playwright }, info) => {
  const url = `/api/conversations/${conversationId}/state`;
  const anon = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await anon.patch(url, { data: { pinned: true } })).status()).toBe(401);
  await anon.dispose();
  expect((await mentee.patch(url, { data: {} })).status()).toBe(400);
  expect((await mentee.patch(url, { data: { mute: 'forever-and-ever' } })).status()).toBe(400);
  // Someone who is not in the thread cannot set anything on it.
  expect((await quietMentee.patch(url, { data: { pinned: true } })).status()).toBe(403);

  const res = await mentee.patch(url, { data: { pinned: true } });
  expect(res.status()).toBe(200);
  const rows = await prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true, pinnedAt: true } });
  expect(rows.find((r) => r.userId === pair.menteeId)?.pinnedAt).not.toBeNull();
  // Per viewer: the mentor's row is untouched.
  expect(rows.find((r) => r.userId === pair.mentorId)?.pinnedAt).toBeNull();
  await mentee.patch(url, { data: { pinned: false } });
});

test('pin and archive from the inbox, and both survive a reload', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, pair.menteeEmail, PASSWORD, '/portal');
  await page.goto('/messages');
  const row = page.getByTestId(`inbox-thread-${conversationId}`);
  await expect(row).toBeVisible();

  await page.getByTestId(`thread-state-menu-${conversationId}`).click();
  await page.getByTestId('thread-state-pin').click();
  await expect(row.getByTestId('thread-pinned')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(`inbox-thread-${conversationId}`).getByTestId('thread-pinned')).toBeVisible();
  await page.getByTestId('inbox-filter-pinned').click();
  await expect(page.getByTestId(`inbox-thread-${conversationId}`)).toBeVisible();

  await page.getByTestId('inbox-filter-all').click();
  await page.getByTestId(`thread-state-menu-${conversationId}`).click();
  await page.getByTestId('thread-state-archive').click();
  await expect(page.getByTestId(`inbox-thread-${conversationId}`)).toHaveCount(0);
  await page.getByTestId('inbox-filter-archived').click();
  await expect(page).toHaveURL(/filter=archived/);
  await expect(page.getByTestId(`inbox-thread-${conversationId}`)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(`inbox-thread-${conversationId}`)).toBeVisible();

  // Someone writing into an archived thread brings it back to the main list.
  const sent = await mentor.post('/api/messages', { data: { conversationId, body: 'Are you still there?' } });
  expect(sent.status()).toBe(201);
  await page.goto('/messages');
  await expect(page.getByTestId(`inbox-thread-${conversationId}`)).toBeVisible();
});

test('a muted thread rings no bell, sends no mail mirror and drops out of the digest', async () => {
  const url = `/api/conversations/${quietConversationId}/state`;
  expect((await quietMentee.patch(url, { data: { mute: 'forever' } })).status()).toBe(200);

  // Live: the mentor writes; the muted mentee gets no bell row and no mirror.
  const since = new Date();
  expect((await quietMentor.post('/api/messages', { data: { conversationId: quietConversationId, body: 'Muted ping' } })).status()).toBe(201);
  expect(await prisma.notification.count({ where: { userId: quiet.menteeId, createdAt: { gte: since } } })).toBe(0);
  expect(await prisma.emailLog.count({ where: { to: quiet.menteeEmail, category: 'message', createdAt: { gte: since } } })).toBe(0);
  // Control: the unmuted mentor is still told when the mentee writes back.
  expect((await quietMentee.post('/api/messages', { data: { conversationId: quietConversationId, body: 'Reply' } })).status()).toBe(201);
  await expect.poll(() => prisma.notification.count({ where: { userId: quiet.mentorId, createdAt: { gte: since } } })).toBeGreaterThan(0);

  // Digest: an old unread mentorship message in each pair; only the unmuted
  // recipient gets a digest, and the muted line is still marked digested.
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const mutedMsg = await prisma.message.create({ data: { relationId: quiet.relationId, senderId: quiet.mentorId, body: 'Old muted line', createdAt: old } });
  await prisma.message.create({ data: { relationId: pair.relationId, senderId: pair.mentorId, body: 'Old open line', createdAt: old } });
  await sendUnreadMessageDigests();
  expect(await prisma.emailLog.count({ where: { to: quiet.menteeEmail, category: 'unread-digest' } })).toBe(0);
  expect(await prisma.emailLog.count({ where: { to: pair.menteeEmail, category: 'unread-digest' } })).toBeGreaterThan(0);
  expect((await prisma.message.findUnique({ where: { id: mutedMsg.id }, select: { digestedAt: true } }))?.digestedAt).not.toBeNull();

  // Unmuting restores the bell.
  expect((await quietMentee.patch(url, { data: { mute: null } })).status()).toBe(200);
  const again = new Date();
  expect((await quietMentor.post('/api/messages', { data: { conversationId: quietConversationId, body: 'Unmuted ping' } })).status()).toBe(201);
  await expect.poll(() => prisma.notification.count({ where: { userId: quiet.menteeId, createdAt: { gte: again } } })).toBeGreaterThan(0);
});
