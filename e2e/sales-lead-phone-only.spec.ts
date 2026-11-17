import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../src/lib/menteeAccount';

// A lead with only a phone number (#3647): the trade-fair stand, the cold call.
// POST /api/sales/leads takes an e-mail OR a phone; without an address the lead
// person is keyed on the normalized phone (`leadContactKey`), so the same
// number typed twice — in any formatting — meets the same dedupe. A refusal
// that points at a colleague names the colleague, and nothing of the lead's own.

test.describe.configure({ mode: 'serial' });

const PW = 'PhoneOnlyLead123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const PHONE = `+49 30 55${String(Date.now()).slice(-6)}`;
// The same number as a German landline is often written.
const PHONE_AGAIN = `0049 (30) 55-${String(Date.now()).slice(-6)}`;
const emails: string[] = [];
const ids: Record<string, string> = {};
let orgId = '';
const contexts: APIRequestContext[] = [];

async function api(playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } }, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  contexts.push(ctx);
  const res = await signInViaApi(ctx, email, PW, { host: MARKETING_HOST, headers: freshIp(`phone-lead-${email}`) });
  expect(res.ok, `${email}: ${res.error}`).toBe(true);
  return ctx;
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Phone ${STAMP}`, slug: `phone-lead-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  for (const label of ['rep1', 'rep2']) {
    const email = uniqueEmail(`phone-${label}-${STAMP}`).toLowerCase();
    emails.push(email);
    ids[label] = (await seedUser(email, PW, 'MENTOR', `Phone ${label === 'rep1' ? 'Ada' : 'Ben'} ${STAMP}`, orgId)).id;
  }
});

test.afterAll(async () => {
  for (const c of contexts) await c.dispose();
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.contactPermission.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a lead with only a phone is created; the same number again is the colleague\'s, named', async ({ playwright, baseURL }) => {
  const rep1 = await api(playwright, baseURL, emails[0]);
  const created = await rep1.post('/api/sales/leads', {
    data: { name: `Acme Phone A ${STAMP}`, country: 'DE', contactName: 'Casey Caller', contactPhone: PHONE },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: body.relationId },
    select: { mentorId: true, companyId: true, mentee: { select: { email: true, phone: true } } },
  });
  expect(relation.mentorId).toBe(ids.rep1);
  // A record, never a login: the lead sits on a generated stand-in address.
  expect(relation.mentee.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(true);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: relation.companyId! } });
  expect(company.contactEmail).toBeNull();
  expect(company.contactPhone).toBe(PHONE);

  // The colleague types the same number, formatted differently, under another name.
  const rep2 = await api(playwright, baseURL, emails[1]);
  const again = await rep2.post('/api/sales/leads', {
    data: { name: `Acme Phone B ${STAMP}`, country: 'DE', contactPhone: PHONE_AGAIN },
  });
  expect(again.status()).toBe(409);
  const refused = await again.json();
  expect(refused).toEqual({ code: 'contact_in_funnel', mine: false, ownerName: `Phone Ada ${STAMP}` });
  // Nothing was written for the colleague.
  expect(await prisma.mentorshipRelation.count({ where: { orgId, mentorId: ids.rep2 } })).toBe(0);
  expect(await prisma.company.count({ where: { orgId, name: `Acme Phone B ${STAMP}` } })).toBe(0);

  // The same account by name, from the colleague: named too.
  const sameAccount = await rep2.post('/api/sales/leads', {
    data: { name: `Acme Phone A ${STAMP}`, country: 'DE', contactPhone: '+49 30 9999999' },
  });
  expect(sameAccount.status()).toBe(409);
  expect(await sameAccount.json()).toEqual({ code: 'account_exists', mine: false, ownerName: `Phone Ada ${STAMP}` });
});

test('neither an e-mail nor a phone, or a phone that is no number, is refused with its own code', async ({ playwright, baseURL }) => {
  const rep1 = await api(playwright, baseURL, emails[0]);
  const none = await rep1.post('/api/sales/leads', { data: { name: `Acme Nothing ${STAMP}`, country: 'DE' } });
  expect(none.status()).toBe(400);
  expect((await none.json()).code).toBe('contact_required');
  const bad = await rep1.post('/api/sales/leads', { data: { name: `Acme Bad ${STAMP}`, country: 'DE', contactPhone: '12' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).code).toBe('phone_invalid');
  expect(await prisma.company.count({ where: { orgId, name: { in: [`Acme Nothing ${STAMP}`, `Acme Bad ${STAMP}`] } } })).toBe(0);
});

test('the rep\'s form takes a phone without an address, and says whose a duplicate is', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, emails[0], PW, '/sales');
  await gotoSettled(page, '/sales');
  await page.getByTestId('new-lead-button').click();
  const dialog = page.getByTestId('new-lead-dialog');

  // Nothing to reach them by: the form says so before posting.
  await dialog.locator('#new-lead-name').fill(`Acme Form Nothing ${STAMP}`);
  await dialog.getByTestId('new-lead-submit').click();
  // Under the field, not in the banner (#3821).
  await expect(dialog.getByText('Enter an e-mail address or a phone number.')).toBeVisible();
  await expect(dialog.getByTestId('new-lead-error')).toHaveCount(0);

  // A phone alone is enough.
  await dialog.locator('#new-lead-name').fill(`Acme Form Phone ${STAMP}`);
  await dialog.locator('#new-lead-country').fill('DE');
  await dialog.locator('#new-lead-contact-phone').fill(`+49 40 77${String(Date.now()).slice(-6)}`);
  await dialog.getByTestId('new-lead-submit').click();
  await expect(dialog.getByTestId('new-lead-created')).toBeVisible();
  expect(await prisma.company.count({ where: { orgId, name: `Acme Form Phone ${STAMP}`, contactEmail: null } })).toBe(1);
});
