import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInAsFreshUser, signInViaApi } from './helpers/auth';

// Paged message threads and scoped message search (#1609).
//
// One pair with a 120-message conversation, and a second pair whose thread
// holds the same search word — so "search finds it" and "search never reaches
// a thread you are not in" are asserted against the same token.

const PASSWORD = 'PagedMsg123!';
const TOTAL = 120;
const DEEP = 7; // index of the message that holds the token: on the third page
const stamp = Date.now();
const TOKEN = `kumquat${stamp}`;

type Page = { messages: { id: string; body: string }[]; hasMore: boolean; nextCursor: string | null };

let pair: SeededRelation;
let outsider: SeededRelation;
let conversationId = '';
let outsiderConversationId = '';
let messageIds: string[] = [];
let mentee: APIRequestContext;
let stranger: APIRequestContext;

async function directConversation(a: string, b: string) {
  return prisma.conversation.create({
    data: { type: 'DIRECT', directKey: [a, b].sort().join('|'), participants: { create: [{ userId: a }, { userId: b }] } },
  });
}

test.beforeAll(async ({ playwright }, info) => {
  pair = await seedMenteeWithRelation('paged-msg', PASSWORD);
  outsider = await seedMenteeWithRelation('paged-out', PASSWORD);
  const conversation = await directConversation(pair.mentorId, pair.menteeId);
  conversationId = conversation.id;
  const t0 = Date.now() - TOTAL * 60_000;
  await prisma.message.createMany({
    data: Array.from({ length: TOTAL }, (_, i) => ({
      conversationId,
      senderId: i % 2 ? pair.mentorId : pair.menteeId,
      body: i === DEEP ? `We agreed the ${TOKEN} plan in week one, 100% sure` : `Paged message ${String(i).padStart(3, '0')}`,
      createdAt: new Date(t0 + i * 60_000),
      readAt: new Date(),
    })),
  });
  messageIds = (
    await prisma.message.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  ).map((m) => m.id);
  const other = await directConversation(outsider.mentorId, outsider.menteeId);
  outsiderConversationId = other.id;
  await prisma.message.create({
    data: { conversationId: other.id, senderId: outsider.mentorId, body: `Private: the ${TOKEN} note`, readAt: new Date() },
  });

  const baseURL = info.project.use.baseURL;
  mentee = await playwright.request.newContext({ baseURL });
  stranger = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(mentee, pair.menteeEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(stranger, outsider.menteeEmail, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await mentee?.dispose();
  await stranger?.dispose();
  for (const s of [pair, outsider]) if (s) await cleanupMenteeWithRelation(s);
});

test('a 120-message thread opens on its newest 50 and pages back without loss', { tag: '@smoke' }, async () => {
  const first = (await (await mentee.get(`/api/messages?conversationId=${conversationId}`)).json()) as Page;
  expect(first.messages).toHaveLength(50);
  expect(first.hasMore).toBe(true);
  // Reading order: oldest of the page first, the newest message last.
  expect(first.messages.map((m) => m.id)).toEqual(messageIds.slice(TOTAL - 50));

  let page = first;
  let seen = first.messages.map((m) => m.id);
  while (page.hasMore) {
    const res = await mentee.get(`/api/messages?conversationId=${conversationId}&before=${encodeURIComponent(page.nextCursor!)}`);
    expect(res.status()).toBe(200);
    page = (await res.json()) as Page;
    seen = [...page.messages.map((m) => m.id), ...seen];
  }
  expect(seen).toEqual(messageIds);

  // The page size is capped, and a cursor that is not one is refused.
  expect(((await (await mentee.get(`/api/messages?conversationId=${conversationId}&limit=500`)).json()) as Page).messages).toHaveLength(100);
  expect((await mentee.get(`/api/messages?conversationId=${conversationId}&before=nope`)).status()).toBe(400);
  // Paging is still the thread's own gate: a stranger gets nothing.
  expect((await stranger.get(`/api/messages?conversationId=${conversationId}&before=${encodeURIComponent(first.nextCursor!)}`)).status()).toBe(403);
});

test('the thread view loads one bounded page and scrolls back on demand', { tag: '@smoke' }, async ({ page }) => {
  const reads: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/messages' && r.method() === 'GET') reads.push(u.search);
  });
  await signInAsFreshUser(page, pair.menteeEmail, PASSWORD, '/portal');
  await page.goto(`/messages/c/${conversationId}`);
  const list = page.getByTestId('thread-messages');
  await expect(list.locator('[data-message-id]')).toHaveCount(50);
  await expect(list.getByText(`Paged message ${TOTAL - 1}`, { exact: true })).toBeVisible();
  expect(reads.every((q) => !q.includes('before='))).toBe(true);

  // Scrolling up to the top asks for the page before; the button does the same.
  // The open smooth-scrolls down to the newest message; a wheel that lands while
  // that scroll is still running is swallowed by it (e2e-full, 2026-10-30). So
  // wheel again until the page before arrives — it is still the scroll that
  // loads it, never the button.
  await expect(async () => {
    await list.hover();
    await page.mouse.wheel(0, -50_000);
    await expect.poll(() => list.locator('[data-message-id]').count(), { timeout: 2_000 }).toBeGreaterThanOrEqual(100);
  }).toPass({ timeout: 20_000 });
  // The last page: the button — unless the wheel's momentum already scrolled
  // the list to its top again and loaded it first, which the production build
  // does often enough that the button can vanish under the click.
  await expect(async () => {
    if ((await list.locator('[data-message-id]').count()) < TOTAL) await page.getByTestId('thread-load-older').click({ timeout: 2_000 });
    await expect(list.locator('[data-message-id]')).toHaveCount(TOTAL, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('thread-load-older')).toHaveCount(0);
  const rendered = await list.locator('[data-message-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id')));
  expect(rendered).toEqual(messageIds);
});

test('search finds a line in your own thread and never one from a thread you are not in', async ({ page }) => {
  const mine = (await (await mentee.get(`/api/messages/search?q=${TOKEN}`)).json()) as { results: { id: string; href: string; thread: { id: string } }[] };
  expect(mine.results.map((r) => r.id)).toEqual([messageIds[DEEP]]);
  expect(mine.results[0].href).toBe(`/messages/c/${conversationId}?m=${messageIds[DEEP]}`);

  const theirs = (await (await stranger.get(`/api/messages/search?q=${TOKEN}`)).json()) as { results: { thread: { id: string } }[] };
  expect(theirs.results).toHaveLength(1);
  expect(theirs.results[0].thread.id).toBe(outsiderConversationId);

  expect((await mentee.get('/api/messages/search?q=a')).status()).toBe(400);
  // LIKE wildcards are text, not patterns: "%%" matches no message here.
  expect(((await (await mentee.get('/api/messages/search?q=%25%25')).json()) as { results: unknown[] }).results).toHaveLength(0);
  expect(((await (await mentee.get('/api/messages/search?q=__')).json()) as { results: unknown[] }).results).toHaveLength(0);
  // …and still find themselves as text.
  const pct = (await (await mentee.get(`/api/messages/search?q=${encodeURIComponent('0% sure')}`)).json()) as { results: { id: string }[] };
  expect(pct.results.map((r) => r.id)).toEqual([messageIds[DEEP]]);
  const anon = await page.request.get(`/api/messages/search?q=${TOKEN}`);
  expect(anon.status()).toBe(401);

  // The hit opens its thread at the message, paging back to reach it.
  await signInAsFreshUser(page, pair.menteeEmail, PASSWORD, '/portal');
  await page.goto('/messages');
  await page.getByTestId('message-search-input').fill(TOKEN);
  await page.getByTestId('message-search-submit').click();
  const results = page.getByTestId('message-search-results');
  await expect(results.getByTestId('message-search-result')).toHaveCount(1);
  await results.getByTestId('message-search-result').click();
  await page.waitForURL((u) => u.pathname === `/messages/c/${conversationId}` && u.searchParams.get('m') === messageIds[DEEP]);
  const hit = page.locator(`#msg-${messageIds[DEEP]}`);
  await expect(hit).toBeInViewport();
  await expect(hit.locator('[data-highlighted="true"]')).toHaveCount(1);

  // A mentorship-only message (not yet adopted into the pair's conversation,
  // #1156) is adopted by the search, so its link opens the conversation at it.
  const legacy = await prisma.message.create({
    data: { relationId: pair.relationId, senderId: pair.mentorId, body: `Legacy ${TOKEN}x line`, createdAt: new Date(Date.now() - (TOTAL + 5) * 60_000), readAt: new Date() },
  });
  const found = (await (await mentee.get(`/api/messages/search?q=${TOKEN}x`)).json()) as { results: { id: string; href: string }[] };
  expect(found.results.map((r) => r.id)).toEqual([legacy.id]);
  expect(found.results[0].href).toBe(`/messages/c/${conversationId}?m=${legacy.id}`);
  await page.goto(found.results[0].href);
  await page.waitForURL((u) => u.pathname === `/messages/c/${conversationId}` && u.searchParams.get('m') === legacy.id);
  await expect(page.locator(`#msg-${legacy.id} [data-highlighted="true"]`)).toHaveCount(1);
});
