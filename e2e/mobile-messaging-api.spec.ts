import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The native app's messaging round-trip (#2775), through the exact requests the
// app makes: NextAuth's own credentials flow with no Origin header
// (signInViaApi), then GET /api/conversations for the inbox, GET /api/messages
// for a thread and a JSON POST to send. Two people, two cookie jars.

const PASSWORD = 'MobileMsg123!';
type Inbox = {
  threads: { conversationId: string; type: string; name: string; otherId: string | null; unread: number; last: { body: string } | null }[];
  supportUnread: number;
};

let seeded: SeededRelation;
let mentor: APIRequestContext;
let mentee: APIRequestContext;

test.beforeAll(async ({ playwright }, info) => {
  seeded = await seedMenteeWithRelation('mobile-msg', PASSWORD);
  const baseURL = info.project.use.baseURL;
  mentor = await playwright.request.newContext({ baseURL });
  mentee = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(mentor, seeded.mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(mentee, seeded.menteeEmail, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await mentor?.dispose();
  await mentee?.dispose();
  if (seeded) await cleanupMenteeWithRelation(seeded);
});

test('GET /api/conversations needs a session', async ({ playwright }, info) => {
  const anon = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await anon.get('/api/conversations')).status()).toBe(401);
  await anon.dispose();
});

test('inbox → send → unread → open thread clears it', async () => {
  // The mentorship surfaces as the pair's one DIRECT conversation (#1156).
  const before = (await (await mentor.get('/api/conversations')).json()) as Inbox;
  const thread = before.threads.find((th) => th.otherId === seeded.menteeId);
  expect(thread, 'the mentee appears in the mentor inbox').toBeTruthy();
  expect(thread!.type).toBe('DIRECT');
  expect(thread!.name).toBe(seeded.menteeName);
  expect(typeof before.supportUnread).toBe('number');

  // The mentee writes from "the app": a JSON POST, no Origin header.
  const body = `Hello from the app ${Date.now()}`;
  const sent = await mentee.post('/api/messages', { data: { conversationId: thread!.conversationId, body } });
  expect(sent.status()).toBe(201);

  const after = (await (await mentor.get('/api/conversations')).json()) as Inbox;
  const updated = after.threads.find((th) => th.conversationId === thread!.conversationId)!;
  expect(updated.unread).toBe(1);
  expect(updated.last?.body).toBe(body);

  // Opening the thread is what marks it read — the same rule as the web.
  const opened = await mentor.get(`/api/messages?conversationId=${thread!.conversationId}`);
  expect(opened.ok()).toBe(true);
  const threadBody = (await opened.json()) as { messages: { body: string; senderId: string }[]; canPost: boolean };
  expect(threadBody.canPost).toBe(true);
  expect(threadBody.messages.at(-1)).toMatchObject({ body, senderId: seeded.menteeId });

  const cleared = (await (await mentor.get('/api/conversations')).json()) as Inbox;
  expect(cleared.threads.find((th) => th.conversationId === thread!.conversationId)!.unread).toBe(0);
});
