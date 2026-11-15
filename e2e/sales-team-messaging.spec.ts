import crypto from 'node:crypto';
import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * Team messaging on the sales surface (src/lib/salesTeamMessagingRule.ts).
 *
 *   - Rep A starts a chat with rep B from the inbox's picker (which lists the
 *     sales team) and B reads it.
 *   - The org's one team room: A writes in it from the UI, B through the API,
 *     and the admin reads both. A deactivated rep can no longer open it and is
 *     off its roster.
 *   - The doors that stay shut (@smoke): a lead the rep does not own, a
 *     customer login and another org's rep are refused (a rep's OWN lead is
 *     reachable through the record, as before — that is not this rule); an INTERNSHIP mentor ↔ mentor pair is refused
 *     exactly as before.
 *   - /messages?to=<id> opens (or creates) the 1:1 chat under the same rule.
 *   - /messages wears the sales menu for a rep: no /mentor link, no global search.
 *
 * SYNTHETIC ONLY: throwaway orgs, example addresses.
 */

const PW = 'TeamChat123!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const mail = {
  repA: uniqueEmail('team-rep-a'),
  repB: uniqueEmail('team-rep-b'),
  admin: uniqueEmail('team-admin'),
  lead: uniqueEmail('team-lead'),
  customer: uniqueEmail('team-customer'),
  foreignRep: uniqueEmail('team-foreign-rep'),
  internA: uniqueEmail('team-intern-mentor-a'),
  internB: uniqueEmail('team-intern-mentor-b'),
};
const names = { repA: `Ada Team ${STAMP}`, repB: `Bea Team ${STAMP}`, admin: `Cem Team ${STAMP}` };
const orgIds: string[] = [];
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const preset = defaultTemplateForVertical('MARKETING')!;
  const marketingOrg = async (tag: string) => {
    const org = await prisma.organization.create({ data: { name: `Acme Team ${tag} ${STAMP}`, slug: `team-${tag}-${STAMP}`, vertical: 'MARKETING' } });
    await prisma.pipelineStage.createMany({ data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })) });
    orgIds.push(org.id);
    return org.id;
  };
  ids.org = await marketingOrg('a');
  ids.foreignOrg = await marketingOrg('b');
  const internship = await prisma.organization.create({ data: { name: `Acme Intern ${STAMP}`, slug: `team-i-${STAMP}`, vertical: 'INTERNSHIP' } });
  orgIds.push(internship.id);

  ids.repA = (await seedUser(mail.repA, PW, 'MENTOR', names.repA, ids.org)).id;
  ids.repB = (await seedUser(mail.repB, PW, 'MENTOR', names.repB, ids.org)).id;
  ids.admin = (await seedUser(mail.admin, PW, 'ADMIN', names.admin, ids.org)).id;
  ids.lead = (await seedUser(mail.lead, PW, 'MENTEE', `Lead Team ${STAMP}`, ids.org)).id;
  ids.customer = (await seedUser(mail.customer, PW, 'COMPANY', `Customer Team ${STAMP}`, ids.org)).id;
  ids.foreignRep = (await seedUser(mail.foreignRep, PW, 'MENTOR', `Foreign Team ${STAMP}`, ids.foreignOrg)).id;
  ids.internA = (await seedUser(mail.internA, PW, 'MENTOR', `Intern Mentor A ${STAMP}`, internship.id)).id;
  ids.internB = (await seedUser(mail.internB, PW, 'MENTOR', `Intern Mentor B ${STAMP}`, internship.id)).id;
});

test.afterAll(async () => {
  const people = Object.values(ids);
  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ teamKey: { in: orgIds.map((id) => `sales-team:${id}`) } }, { participants: { some: { userId: { in: people } } } }] },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: people } } });
  for (const email of Object.values(mail)) await cleanupByEmail(email);
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
});

/** A fresh API session for `email`, on the marketing host unless told otherwise. */
async function apiAs(browser: Browser, email: string, onHost: Record<string, string> | null = host): Promise<APIRequestContext> {
  const context = await browser.newContext(onHost ? { extraHTTPHeaders: onHost } : {});
  const signedIn = await signInViaApi(context.request, email, PW);
  expect(signedIn.ok, `sign-in ${email}`).toBe(true);
  return context.request;
}

const startChat = (api: APIRequestContext, userId: string) => api.post('/api/conversations', { data: { userId } });

test('a rep cannot open a chat with a lead they do not own, a customer login or another org\'s rep', { tag: '@smoke' }, async ({ browser }) => {
  const rep = await apiAs(browser, mail.repA);
  for (const [target, why] of [
    [ids.lead, 'a lead'],
    [ids.customer, 'a customer login'],
    [ids.foreignRep, "another org's rep"],
  ] as const) {
    const res = await startChat(rep, target);
    expect([403, 404], `${why} → ${res.status()}`).toContain(res.status());
  }
  // …and nothing was created for any of them.
  expect(
    await prisma.conversation.count({
      where: { type: 'DIRECT', participants: { some: { userId: { in: [ids.lead, ids.customer, ids.foreignRep] } } } },
    }),
  ).toBe(0);
});

test('INTERNSHIP is unchanged: two mentors with no project or mentorship between them are refused', { tag: '@smoke' }, async ({ browser }) => {
  const mentor = await apiAs(browser, mail.internA, null);
  expect((await startChat(mentor, ids.internB)).status()).toBe(403);
});

test('rep A starts a chat with rep B from the inbox picker, and B reads it', async ({ page, browser, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await signInAndSettle(page, mail.repA, PW, '/sales');
  await gotoSettled(page, '/messages');
  await page.getByTestId('new-chat-toggle').first().click();
  const candidate = page.getByTestId('new-chat-candidate').filter({ hasText: names.repB });
  await expect(candidate).toBeVisible({ timeout: 10_000 });
  // The picker offers the sales team, never the lead or the customer.
  await expect(page.getByTestId('new-chat-candidate').filter({ hasText: `Lead Team ${STAMP}` })).toHaveCount(0);
  await expect(page.getByTestId('new-chat-candidate').filter({ hasText: `Customer Team ${STAMP}` })).toHaveCount(0);
  await candidate.click();
  await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
  const conversationId = new URL(page.url()).pathname.split('/').pop()!;
  const text = `Can you take the Monday demo? ${STAMP}`;
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-send').click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 10_000 });

  const b = await apiAs(browser, mail.repB);
  await expect
    .poll(async () => {
      const body = await (await b.get(`/api/messages?conversationId=${conversationId}`)).json();
      return (body.messages ?? []).map((m: { body: string }) => m.body);
    }, { timeout: 10_000 })
    .toContain(text);
});

test('/messages?to= opens the chat with a colleague, and refuses anyone the rule does not allow', async ({ page, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await signInAndSettle(page, mail.repB, PW, '/sales');
  // A colleague: straight into the 1:1 chat (created on first use).
  await page.goto(`/messages?to=${ids.admin}`);
  await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
  const conversationId = new URL(page.url()).pathname.split('/').pop()!;
  const pair = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { participants: true } });
  expect(pair?.type).toBe('DIRECT');
  expect(pair!.participants.map((p) => p.userId).sort()).toEqual([ids.admin, ids.repB].sort());
  // Another org's rep and a lead the rep does not own: the inbox, with a notice, and no chat.
  for (const target of [ids.foreignRep, ids.lead]) {
    await gotoSettled(page, `/messages?to=${target}`);
    expect(new URL(page.url()).pathname).toBe('/messages');
    await expect(page.getByTestId('messages-to-refused')).toBeVisible();
  }
  expect(
    await prisma.conversation.count({ where: { type: 'DIRECT', participants: { some: { userId: { in: [ids.foreignRep, ids.lead] } } } } }),
  ).toBe(0);
});

test('the team room: two reps write, the admin reads both; a deactivated rep loses it', async ({ page, browser, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await signInAndSettle(page, mail.repA, PW, '/sales');
  await gotoSettled(page, '/messages');

  // The room is created on first visit — once, keyed by the org.
  const room = await prisma.conversation.findUnique({ where: { teamKey: `sales-team:${ids.org}` } });
  expect(room).not.toBeNull();
  const row = page.getByTestId(`inbox-thread-${room!.id}`);
  await expect(row).toContainText('Team');
  await row.getByRole('link').click();
  await page.waitForURL(`**/messages/c/${room!.id}`, { timeout: 20_000 });
  const fromA = `Morning team, pipeline review at 10 ${STAMP}`;
  await page.getByTestId('message-input').fill(fromA);
  await page.getByTestId('message-send').click();
  await expect(page.getByText(fromA)).toBeVisible({ timeout: 10_000 });

  // B writes from the API: the room opens for every rep of the org, live.
  const b = await apiAs(browser, mail.repB);
  const fromB = `On it, bringing the trial numbers ${STAMP}`;
  expect((await b.post('/api/messages', { data: { conversationId: room!.id, body: fromB } })).status()).toBe(201);

  // The admin, who never opened it, reads both.
  const admin = await apiAs(browser, mail.admin);
  const seen = await (await admin.get(`/api/messages?conversationId=${room!.id}`)).json();
  expect(seen.messages.map((m: { body: string }) => m.body)).toEqual(expect.arrayContaining([fromA, fromB]));
  expect(seen.teamRoom).toBe(true);

  // The room stays one room, however many first visits there were.
  expect(await prisma.conversation.count({ where: { teamKey: `sales-team:${ids.org}` } })).toBe(1);
  // In-app only: the bell reaches the team, no e-mail mirror is queued for the room.
  await expect.poll(() => prisma.notification.count({ where: { userId: ids.repB, link: `/messages/c/${room!.id}` } })).toBeGreaterThan(0);

  // B is deactivated: the room no longer opens for them, and they are off its roster.
  await prisma.user.update({ where: { id: ids.repB }, data: { isActive: false } });
  try {
    const refused = await b.get(`/api/messages?conversationId=${room!.id}`);
    expect([401, 403], `deactivated rep → ${refused.status()}`).toContain(refused.status());
    const roster = await (await admin.get(`/api/messages?conversationId=${room!.id}`)).json();
    expect(roster.participants.map((p: { id: string }) => p.id)).not.toContain(ids.repB);
  } finally {
    await prisma.user.update({ where: { id: ids.repB }, data: { isActive: true } });
  }
});

test('/messages wears the sales menu for a rep: messages, to-dos and notifications, no /mentor link, no global search', async ({ page, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await signInAndSettle(page, mail.repA, PW, '/sales');
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSettled(page, '/messages');
  const nav = page.getByTestId('sales-nav');
  await expect(nav).toBeVisible();
  await expect(nav.locator('a[href="/messages"]')).toBeVisible();
  await expect(nav.locator('a[href="/todos"]')).toBeVisible();
  await expect(nav.locator('a[href="/notifications"]')).toBeVisible();
  await expect(nav.locator('a[href="/sales"]')).toBeVisible();
  await expect(page.locator('a[href^="/mentor"]')).toHaveCount(0);
  await expect(page.getByTestId('global-search-input')).toHaveCount(0);

  await gotoSettled(page, '/todos');
  await expect(page.getByTestId('sales-nav')).toBeVisible();
  await expect(page.locator('a[href^="/mentor"]')).toHaveCount(0);
});
