import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, setOrgFeature, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

// Self-served company webhooks (#2006). A COMPANY owner registers a hook for
// its own hiring events: the event list is capped (above → 403, never trimmed),
// the URL goes through the SSRF guard, another company's hook is invisible —
// and, the part that matters, fan-out delivers a company hook ONLY the events
// whose subject is that company's, even after an admin widens its event list.
//
// Delivery is asserted on the queue: a real route raises the event, the worker
// fans it out, and the `webhook.deliver` jobs it enqueues (keyed
// `whk:<eventId>:<hookId>`) name exactly the hooks that receive it. The target
// is a literal address that answers nothing useful; no assertion depends on it.

const PW = 'CompanyHooks123!';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
// A literal public address: passes the guard, never resolved or called here.
const TARGET = 'https://93.184.215.14/hooks/company-e2e';
const URL_PATH = '/api/company/integrations/webhooks';

let orgId = '';
let companyA = '';
let companyB = '';
const contexts: APIRequestContext[] = [];
const emails = { a: uniqueEmail('chooks-a'), b: uniqueEmail('chooks-b'), mentor: uniqueEmail('chooks-mentor') };

async function signedIn(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

function deliveriesFor(eventId: string) {
  return prisma.job.findMany({ where: { name: 'webhook.deliver', idempotencyKey: { startsWith: `whk:${eventId}:` } }, select: { payload: true } });
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `CHooks ${stamp}`, slug: `chooks-${stamp}` } })).id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  [companyA, companyB] = (await Promise.all(['A', 'B'].map((n) => prisma.company.create({ data: { orgId, name: `CHooks ${n} ${stamp}` } })))).map((c) => c.id);
  const [ua, ub] = await Promise.all([
    seedUser(emails.a, PW, 'COMPANY', 'CHooks A', orgId),
    seedUser(emails.b, PW, 'COMPANY', 'CHooks B', orgId),
    seedUser(emails.mentor, PW, 'MENTOR', 'CHooks Mentor', orgId),
  ]);
  await prisma.user.update({ where: { id: ua.id }, data: { companyId: companyA } });
  await prisma.user.update({ where: { id: ub.id }, data: { companyId: companyB } });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (!orgId) return;
  await prisma.job.deleteMany({ where: { orgId, name: 'webhook.deliver' } });
  await prisma.activityLog.deleteMany({ where: { orgId } });
  await prisma.webhook.deleteMany({ where: { orgId } });
  await prisma.companyInterest.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
  await prisma.domainEvent.deleteMany({ where: { orgId } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.company.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('a company registers a hook for its own hiring events; the ceiling, the SSRF guard and other companies hold', { tag: '@smoke' }, async () => {
  const [a, b, mentor] = await Promise.all([signedIn(emails.a), signedIn(emails.b), signedIn(emails.mentor)]);
  expect((await mentor.post(URL_PATH, { data: { url: TARGET, events: ['requisition.filled'] } })).status()).toBe(403);

  const above = await a.post(URL_PATH, { data: { url: TARGET, events: ['requisition.filled', 'pipeline.stage_change'] } });
  expect(above.status()).toBe(403);
  expect(await above.json()).toMatchObject({ code: 'event_above_ceiling', events: ['pipeline.stage_change'] });
  expect((await a.post(URL_PATH, { data: { url: 'https://127.0.0.1/x', events: ['requisition.filled'] } })).status()).toBe(400);
  expect(await prisma.webhook.count({ where: { orgId } })).toBe(0);

  const created = await a.post(URL_PATH, { data: { url: TARGET, events: ['requisition.filled', 'offer.accepted'] } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.secret).toMatch(/^[0-9a-f]{48}$/);
  const row = await prisma.webhook.findUniqueOrThrow({ where: { id: body.webhook.id } });
  expect(row).toMatchObject({ orgId, companyId: companyA, source: 'company' });

  // B neither sees nor deletes it.
  expect((await (await b.get(URL_PATH)).json()).webhooks).toEqual([]);
  expect((await b.delete(`${URL_PATH}?id=${row.id}`)).status()).toBe(404);
  expect((await (await a.get(URL_PATH)).json()).webhooks.map((h: { id: string }) => h.id)).toEqual([row.id]);
});

test('fan-out delivers a company hook only its own company\'s events, whatever its event list says', { tag: '@smoke' }, async () => {
  test.setTimeout(150_000);
  const [a, b] = await Promise.all([signedIn(emails.a), signedIn(emails.b)]);
  // A's hook also lists a programme event (as if an admin had widened it).
  const hookA = await prisma.webhook.create({
    data: { orgId, companyId: companyA, url: TARGET, secret: 'a', source: 'company', events: ['company_interest.changed', 'pipeline.stage_change'] },
  });
  const hookB = await prisma.webhook.create({ data: { orgId, companyId: companyB, url: TARGET, secret: 'b', source: 'company', events: ['company_interest.changed'] } });
  const orgWide = await prisma.webhook.create({ data: { orgId, url: TARGET, secret: 'o', events: ['company_interest.changed'] } });

  // A real event from a real route: company A flags its own candidate.
  const stamp = randomBytes(3).toString('hex');
  const [mentorRow, menteeRow] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { email: emails.mentor } }),
    seedUser(uniqueEmail(`chooks-mentee-${stamp}`), PW, 'MENTEE', 'CHooks Mentee', orgId),
  ]);
  await prisma.mentorshipRelation.create({ data: { orgId, mentorId: mentorRow.id, menteeId: menteeRow.id, companyId: companyA } });
  const flagged = await a.post('/api/company/interests', { data: { menteeId: menteeRow.id, status: 'INTERESTED' } });
  expect(flagged.status()).toBe(200);
  // B cannot flag a candidate that is not theirs: no event for it.
  expect((await b.post('/api/company/interests', { data: { menteeId: menteeRow.id, status: 'INTERESTED' } })).status()).toBe(404);

  const ev = await prisma.domainEvent.findFirstOrThrow({ where: { orgId, name: 'company_interest.changed' } });
  // The worker fans the event out; A's hook and the org-wide one get a job.
  await expect
    .poll(async () => (await deliveriesFor(ev.id)).map((j) => (j.payload as { webhookId: string }).webhookId).sort(), { timeout: 120_000 })
    .toEqual([hookA.id, orgWide.id].sort());
  // …and B's hook never does.
  expect((await deliveriesFor(ev.id)).some((j) => (j.payload as { webhookId: string }).webhookId === hookB.id)).toBe(false);
});

test('the company integrations page registers a webhook, shows the secret once and deletes it', async ({ page }) => {
  expect((await signInViaApi(page.request, emails.b, PW)).ok).toBe(true);
  await gotoSettled(page, '/company/integrations');
  await page.getByTestId('company-hook-url').fill(TARGET);
  await page.getByTestId('company-hook-event-offer.accepted').check();
  await page.getByTestId('company-hook-create').click();
  await expect(page.getByTestId('company-hook-secret').locator('code')).toHaveText(/^[0-9a-f]{48}$/);
  const row = await prisma.webhook.findFirstOrThrow({ where: { orgId, companyId: companyB, events: { equals: ['offer.accepted'] } } });
  await expect(page.getByTestId(`company-hook-${row.id}`)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`company-hook-delete-${row.id}`).click();
  await expect(page.getByTestId(`company-hook-${row.id}`)).toHaveCount(0);
  expect(await prisma.webhook.count({ where: { id: row.id } })).toBe(0);
});
