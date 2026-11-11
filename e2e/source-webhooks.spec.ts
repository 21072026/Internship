import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, setOrgFeature, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

// Self-served SOURCE webhooks (#2006) — the company model (company-webhooks.spec)
// over the candidates a referring source owns. The event list is capped (above
// → 403, never trimmed), the URL goes through the SSRF guard, another source's
// hook is invisible — and fan-out delivers a source hook ONLY the events whose
// candidate that source referred, even after an admin widens its event list.
//
// Delivery is asserted on the queue: a real route raises the event, the worker
// fans it out, and the `webhook.deliver` jobs it enqueues (keyed
// `whk:<eventId>:<hookId>`) name exactly the hooks that receive it.

const PW = 'SourceHooks123!';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
// A literal public address: passes the guard, never resolved or called here.
const TARGET = 'https://93.184.215.14/hooks/source-e2e';
const URL_PATH = '/api/source/integrations/webhooks';

let orgId = '';
let sourceA = '';
let sourceB = '';
const contexts: APIRequestContext[] = [];
const emails = { a: uniqueEmail('shooks-a'), b: uniqueEmail('shooks-b'), company: uniqueEmail('shooks-company') };

async function signedIn(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

const deliveriesFor = (eventId: string) =>
  prisma.job.findMany({ where: { name: 'webhook.deliver', idempotencyKey: { startsWith: `whk:${eventId}:` } }, select: { payload: true } });

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `SHooks ${stamp}`, slug: `shooks-${stamp}` } })).id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  [sourceA, sourceB] = (await Promise.all(['A', 'B'].map((n) => prisma.source.create({ data: { orgId, name: `SHooks ${n} ${stamp}` } })))).map((s) => s.id);
  const [ua, ub] = await Promise.all([
    seedUser(emails.a, PW, 'SOURCE', 'SHooks A', orgId),
    seedUser(emails.b, PW, 'SOURCE', 'SHooks B', orgId),
    seedUser(emails.company, PW, 'COMPANY', 'SHooks Company', orgId),
  ]);
  await prisma.user.update({ where: { id: ua.id }, data: { sourceId: sourceA } });
  await prisma.user.update({ where: { id: ub.id }, data: { sourceId: sourceB } });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (!orgId) return;
  await prisma.job.deleteMany({ where: { orgId, name: 'webhook.deliver' } });
  await prisma.activityLog.deleteMany({ where: { orgId } });
  await prisma.webhook.deleteMany({ where: { orgId } });
  await prisma.domainEvent.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.source.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('a source registers a hook for its own candidates; the ceiling, the SSRF guard and other sources hold', { tag: '@smoke' }, async () => {
  const [a, b, company] = await Promise.all([signedIn(emails.a), signedIn(emails.b), signedIn(emails.company)]);
  expect((await company.post(URL_PATH, { data: { url: TARGET, events: ['user.created'] } })).status()).toBe(403);

  const above = await a.post(URL_PATH, { data: { url: TARGET, events: ['user.created', 'offer.accepted'] } });
  expect(above.status()).toBe(403);
  expect(await above.json()).toMatchObject({ code: 'event_above_ceiling', events: ['offer.accepted'] });
  expect((await a.post(URL_PATH, { data: { url: 'https://127.0.0.1/x', events: ['user.created'] } })).status()).toBe(400);
  expect(await prisma.webhook.count({ where: { orgId } })).toBe(0);

  const created = await a.post(URL_PATH, { data: { url: TARGET, events: ['user.created', 'mentorship.created'] } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.secret).toMatch(/^[0-9a-f]{48}$/);
  const row = await prisma.webhook.findUniqueOrThrow({ where: { id: body.webhook.id } });
  expect(row).toMatchObject({ orgId, sourceId: sourceA, companyId: null, source: 'source' });
  expect(await prisma.activityLog.count({ where: { action: 'webhook.created', targetId: row.id, level: 'WARNING' } })).toBe(1);

  // B neither sees nor deletes it.
  expect((await (await b.get(URL_PATH)).json()).webhooks).toEqual([]);
  expect((await b.delete(`${URL_PATH}?id=${row.id}`)).status()).toBe(404);
  expect((await (await a.get(URL_PATH)).json()).webhooks.map((h: { id: string }) => h.id)).toEqual([row.id]);
  expect((await a.delete(`${URL_PATH}?id=${row.id}`)).status()).toBe(200);
  expect(await prisma.webhook.count({ where: { id: row.id } })).toBe(0);
});

test('fan-out delivers a source hook only its own candidates\' events, whatever its event list says', { tag: '@smoke' }, async () => {
  test.setTimeout(150_000);
  const a = await signedIn(emails.a);
  // A's hook also lists a hiring event (as if an admin had widened it).
  const hookA = await prisma.webhook.create({ data: { orgId, sourceId: sourceA, url: TARGET, secret: 'a', source: 'source', events: ['user.created', 'application.stage_changed'] } });
  const hookB = await prisma.webhook.create({ data: { orgId, sourceId: sourceB, url: TARGET, secret: 'b', source: 'source', events: ['user.created'] } });
  const orgWide = await prisma.webhook.create({ data: { orgId, url: TARGET, secret: 'o', events: ['user.created'] } });

  // A real event from a real route: source A refers a new candidate.
  const referred = await a.post('/api/source/mentees', { data: { fullName: 'SHooks Candidate', email: uniqueEmail('shooks-cand') } });
  expect(referred.status()).toBe(201);
  const menteeId = (await referred.json()).mentee.id as string;
  const ev = await prisma.domainEvent.findFirstOrThrow({ where: { orgId, name: 'user.created', subjectId: menteeId } });

  // The worker fans it out: A's hook and the org-wide one get a job…
  await expect
    .poll(async () => (await deliveriesFor(ev.id)).map((j) => (j.payload as { webhookId: string }).webhookId).sort(), { timeout: 120_000 })
    .toEqual([hookA.id, orgWide.id].sort());
  // …and B's hook never does.
  expect((await deliveriesFor(ev.id)).some((j) => (j.payload as { webhookId: string }).webhookId === hookB.id)).toBe(false);
});

test('the source integrations page registers a webhook, shows the secret once and deletes it', async ({ page }) => {
  expect((await signInViaApi(page.request, emails.b, PW)).ok).toBe(true);
  await gotoSettled(page, '/source/integrations');
  await page.getByTestId('company-hook-url').fill(TARGET);
  await page.getByTestId('company-hook-event-mentorship.created').check();
  await page.getByTestId('company-hook-create').click();
  await expect(page.getByTestId('company-hook-secret').locator('code')).toHaveText(/^[0-9a-f]{48}$/);
  const row = await prisma.webhook.findFirstOrThrow({ where: { orgId, sourceId: sourceB, events: { equals: ['mentorship.created'] } } });
  await expect(page.getByTestId(`company-hook-${row.id}`)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`company-hook-delete-${row.id}`).click();
  await expect(page.getByTestId(`company-hook-${row.id}`)).toHaveCount(0);
  expect(await prisma.webhook.count({ where: { id: row.id } })).toBe(0);
});
