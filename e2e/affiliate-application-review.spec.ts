import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

// The admin's decision on a partner application (docs/affiliate-module.md, #3362).
//
// What this pins:
//   1. @smoke — an observer cannot decide, another org's admin gets 404 for the
//      id, and a decision happens once (409 for the second click);
//   2. an approval creates the partner with the chosen code and an AFFILIATE
//      invitation bound to it; a taken or malformed code is refused and leaves
//      the application pending;
//   3. a rejection stores the reason CODE only — the admin's note is in the audit
//      row and nowhere else — and the applicant's mail is the decision category;
//   4. the screen lists the pending application with its suggested code.
//
// SYNTHETIC ONLY: throwaway MARKETING orgs per run.

const PW = 'AffReview123!';
const host = asHost(MARKETING_HOST);
const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let orgId = '';
let otherOrgId = '';
const emails = { owner: uniqueEmail('aff-review-owner'), observer: uniqueEmail('aff-review-observer'), stranger: uniqueEmail('aff-review-stranger') };
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };
async function as(playwright: RequestFactory, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok, `${email} sign-in`).toBe(true);
  return ctx;
}

async function application(first: string, email: string) {
  return (
    await prisma.affiliateApplication.create({
      data: { orgId, firstName: first, lastName: 'Example', email, heardFrom: 'search', consentAt: new Date(), consentTextVersion: 'test', locale: 'en' },
    })
  ).id;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-review-${stamp}`, vertical: 'MARKETING' } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Beta Sales ${stamp}`, slug: `aff-review-b-${stamp}`, vertical: 'MARKETING' } })).id;
  await seedUser(emails.owner, PW, 'ADMIN', 'Review Owner', { orgId });
  const observer = await seedUser(emails.observer, PW, 'ADMIN', 'Review Observer', { orgId });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await seedUser(emails.stranger, PW, 'ADMIN', 'Other Org Admin', { orgId: otherOrgId });
  await prisma.affiliatePartner.create({ data: { orgId, code: 'taken-1', displayName: 'Existing Partner' } });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await prisma.invitationToken.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateApplication.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.emailLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  for (const id of [orgId, otherOrgId].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

test('only the org’s own writing admins decide, and only once', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const id = await application('Ada', `ada-${stamp}@partner.example`);
  const owner = await as(playwright, baseURL, emails.owner);
  const observer = await as(playwright, baseURL, emails.observer);
  const stranger = await as(playwright, baseURL, emails.stranger);
  const approve = (ctx: APIRequestContext, code: string) => ctx.post(`/api/admin/affiliate/applications/${id}/approve`, { headers: host, data: { code } });

  expect((await approve(observer, 'ada-1')).status()).toBe(403);
  expect((await observer.post(`/api/admin/affiliate/applications/${id}/reject`, { headers: host, data: { reason: 'other' } })).status()).toBe(403);
  expect((await approve(stranger, 'ada-1')).status()).toBe(404);
  // The observer reads, and sees no other org's rows.
  const listed = await (await observer.get('/api/admin/affiliate/applications?status=PENDING', { headers: host })).json();
  expect(listed.canWrite).toBe(false);
  expect(listed.applications.map((a: { id: string }) => a.id)).toContain(id);
  expect((await (await stranger.get('/api/admin/affiliate/applications', { headers: host })).json()).applications).toHaveLength(0);

  const ok = await approve(owner, 'ada-1');
  expect(ok.status()).toBe(201);
  const second = await approve(owner, 'ada-2');
  expect([second.status(), (await second.json()).code]).toEqual([409, 'already_decided']);
});

test('an approval creates the partner and its invitation; a bad code changes nothing', async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails.owner);
  const email = `bo-${stamp}@partner.example`;
  const id = await application('Bo', email);
  const approve = (code: string) => owner.post(`/api/admin/affiliate/applications/${id}/approve`, { headers: host, data: { code } });

  expect([(await approve('has space')).status()]).toEqual([400]);
  const taken = await approve('TAKEN-1');
  expect([taken.status(), (await taken.json()).code]).toEqual([409, 'code_taken']);
  expect((await prisma.affiliateApplication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');

  const res = await approve('bo-example');
  expect(res.status()).toBe(201);
  const body = await res.json();
  const partner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: body.partnerId } });
  expect(partner).toMatchObject({ orgId, code: 'bo-example', displayName: 'Bo Example', contactEmail: email, status: 'ACTIVE' });
  expect(await prisma.invitationToken.count({ where: { orgId, email, role: 'AFFILIATE', partnerId: partner.id } })).toBe(1);
  expect(await prisma.affiliateApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'APPROVED', partnerId: partner.id });
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.application.approve', targetId: id } })).toBe(1);
  // The same trail as a partner added by hand.
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.create', targetId: partner.id } })).toBe(1);

  // A second application from an address that is now a partner's contact is refused, not turned into a second partner.
  const again = await application('Bo', email);
  const dup = await owner.post(`/api/admin/affiliate/applications/${again}/approve`, { headers: host, data: { code: 'bo-2' } });
  expect([dup.status(), (await dup.json()).code]).toEqual([409, 'email_is_partner']);
  expect(await prisma.affiliatePartner.count({ where: { orgId, contactEmail: email } })).toBe(1);
});

test('a rejection keeps the reason code; the note stays in the audit row', async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails.owner);
  const email = `cy-${stamp}@partner.example`;
  const id = await application('Cy', email);
  const reject = (data: unknown) => owner.post(`/api/admin/affiliate/applications/${id}/reject`, { headers: host, data });

  expect((await reject({ reason: 'rude' })).status()).toBe(400);
  expect((await reject({ reason: 'incomplete', note: 'internal remark xyz' })).status()).toBe(200);
  const row = await prisma.affiliateApplication.findUniqueOrThrow({ where: { id } });
  expect(row).toMatchObject({ status: 'REJECTED', decisionCode: 'incomplete' });
  expect(JSON.stringify(row)).not.toContain('internal remark');
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId, action: 'affiliate.application.reject', targetId: id } });
  expect(audit.detail).toContain('internal remark xyz');
  await expect.poll(() => prisma.emailLog.count({ where: { orgId, category: 'affiliate-application-decision' } }), { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await reject({ reason: 'other' })).status()).toBe(409);
});

test('the screen lists a pending application with its suggested code', async ({ page }) => {
  await application('Dee', `dee-${stamp}@partner.example`);
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.owner, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/applications');
  const list = page.getByTestId('affiliate-applications-list');
  await expect(list.getByText('Dee Example')).toBeVisible();
  await expect(list.getByTestId('affiliate-application-code').first()).toHaveValue('dee-example');
  const pending = await prisma.affiliateApplication.count({ where: { orgId, status: 'PENDING' } });
  await expect(page.getByTestId('affiliate-applications-pending')).toHaveText(String(pending));
});
