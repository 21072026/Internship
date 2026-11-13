import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * The lead's contact on its record page (#3655, src/lib/salesLeadContact.ts).
 *
 * A marketing lead's user row carries an `@import.local` stand-in address; the
 * person the rep calls is the account's primary contact. What this pins:
 *   - the page shows the account's contact, never the stand-in address;
 *   - the record's rep corrects it in place: the account's four contact columns
 *     and the lead's name and phone move together, the login address never does;
 *   - the change is audited with the field names only, and nobody is mailed;
 *   - another rep's record and an unknown id are the same 404, an observer admin
 *     is refused, an admin holding company.write may correct any record;
 *   - another tenant's record is the same 404 for the rep and the admin (@smoke);
 *   - an address another contact of the account holds is 409 duplicate_email
 *     (the one writer's test, src/lib/companyContacts.ts);
 *   - an unchanged contact still brings a stale lead row back in step;
 *   - a record without an account has no editor and answers 409.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, example addresses.
 */

const PASSWORD = 'LeadContact123!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const emails = {
  rep: uniqueEmail('lc-rep'),
  rep2: uniqueEmail('lc-rep2'),
  admin: uniqueEmail('lc-admin'),
  observer: uniqueEmail('lc-observer'),
};
const STAND_IN = `lc-lead-${STAMP}@import.local`;
const STAND_IN_2 = `lc-lead2-${STAMP}@import.local`;

let orgId = '';
let otherOrgId = '';
const ids = { relation: '', bare: '', company: '', lead: '', foreign: '' };
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${STAMP}`, slug: `lead-contact-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId })) });
  const rep = await seedUser(emails.rep, PASSWORD, 'MENTOR', `LC Rep ${STAMP}`, orgId);
  await seedUser(emails.rep2, PASSWORD, 'MENTOR', `LC Rep2 ${STAMP}`, orgId);
  await seedUser(emails.admin, PASSWORD, 'ADMIN', `LC Admin ${STAMP}`, orgId);
  const observer = await seedUser(emails.observer, PASSWORD, 'ADMIN', `LC Observer ${STAMP}`, orgId);
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });

  const company = await prisma.company.create({
    data: { orgId, name: `Example Shop ${STAMP}`, contactName: 'Tobias Example', contactEmail: 'tobias@shop.example', contactPhone: '+49 30 1234567' },
  });
  ids.company = company.id;
  // The lead row as the import makes it: a stand-in address and no login.
  const lead = await prisma.user.create({
    data: { orgId, email: STAND_IN, password: 'x', role: 'MENTEE', fullName: 'Tobias Example', phone: '+49 30 1234567', skills: [], companyId: company.id },
  });
  ids.lead = lead.id;
  ids.relation = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'LEAD_CONTACTED' } })).id;
  // A hand-made record with no account at all.
  const bareLead = await prisma.user.create({ data: { orgId, email: STAND_IN_2, password: 'x', role: 'MENTEE', fullName: 'No Account', skills: [] } });
  ids.bare = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: rep.id, menteeId: bareLead.id, pipelineStatus: 'LEAD_NEW' } })).id;

  // Another person in the account's address book: their address is taken.
  await prisma.companyContact.create({ data: { orgId, companyId: company.id, name: 'Erika Example', email: 'erika@shop.example' } });

  // Another tenant's record, owned by a rep of that tenant.
  otherOrgId = (await prisma.organization.create({ data: { name: `Beta Sales ${STAMP}`, slug: `lead-contact-b-${STAMP}`, vertical: 'MARKETING' } })).id;
  const foreignRep = await prisma.user.create({ data: { orgId: otherOrgId, email: `lc-frep-${STAMP}@import.local`, password: 'x', role: 'MENTOR', fullName: 'Foreign Rep', skills: [] } });
  const foreignCompany = await prisma.company.create({ data: { orgId: otherOrgId, name: `Beta Shop ${STAMP}`, contactName: 'Foreign Contact' } });
  const foreignLead = await prisma.user.create({ data: { orgId: otherOrgId, email: `lc-flead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: 'Foreign Contact', skills: [], companyId: foreignCompany.id } });
  ids.foreign = (await prisma.mentorshipRelation.create({ data: { orgId: otherOrgId, mentorId: foreignRep.id, menteeId: foreignLead.id, companyId: foreignCompany.id, pipelineStatus: 'LEAD_NEW' } })).id;

  for (const key of Object.keys(emails) as (keyof typeof emails)[]) {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
    expect((await signInViaApi(ctx, emails[key], PASSWORD, { host: MARKETING_HOST })).ok, key).toBe(true);
    contexts.push(ctx);
    api[key] = ctx;
  }
});

const api = {} as Record<keyof typeof emails, APIRequestContext>;
const patch = (who: keyof typeof emails, id: string, data: unknown) => api[who].patch(`/api/sales/leads/${id}/contact`, { headers: host, data: data as object });

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: id, email: { endsWith: '@import.local' } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of Object.values(emails)) await cleanupByEmail(e);
  for (const id of [orgId, otherOrgId].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

test('the rep sees the account contact and corrects it in place; nothing is mailed', async ({ page }) => {
  test.slow();
  const mailsBefore = await prisma.emailLog.count({ where: { orgId } });
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.rep, PASSWORD, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.relation}`);

  await expect(page.getByTestId('sales-lead-email')).toContainText('tobias@shop.example');
  await expect(page.getByTestId('sales-lead-contact')).not.toContainText('import.local');

  await page.getByTestId('sales-lead-contact-edit').click();
  await page.getByTestId('sales-lead-contact-input-name').fill('Tobias Beispiel');
  await page.getByTestId('sales-lead-contact-input-position').fill('Managing director');
  await page.getByTestId('sales-lead-contact-input-email').fill('T.Beispiel@Shop.example');
  await page.getByTestId('sales-lead-contact-input-phone').fill('+49 30 7654321');
  await page.getByTestId('sales-lead-contact-save').click();

  await expect(page.getByTestId('sales-lead-email')).toContainText('t.beispiel@shop.example');
  await expect(page.getByTestId('sales-lead-contact-position')).toContainText('Managing director');
  await expect(page.getByTestId('sales-lead-name')).toHaveText('Tobias Beispiel');

  const company = await prisma.company.findUnique({ where: { id: ids.company } });
  expect(company).toMatchObject({ contactName: 'Tobias Beispiel', contactEmail: 't.beispiel@shop.example', contactPhone: '+49 30 7654321', contactPosition: 'Managing director' });
  // The lead row follows the name and phone; its login address never moves.
  const lead = await prisma.user.findUnique({ where: { id: ids.lead } });
  expect(lead).toMatchObject({ fullName: 'Tobias Beispiel', phone: '+49 30 7654321', email: STAND_IN });

  const audit = await prisma.auditLog.findFirst({ where: { orgId, action: 'sales.lead.contact.update', targetId: ids.relation } });
  expect(JSON.parse(audit!.detail!)).toEqual({ companyId: ids.company, changed: ['name', 'email', 'phone', 'position'], leadRow: ['name', 'phone'] });
  expect(audit!.detail).not.toContain('shop.example');
  expect(await prisma.emailLog.count({ where: { orgId } })).toBe(mailsBefore);
});

test('an unchanged save writes nothing', async () => {
  const before = await prisma.auditLog.count({ where: { orgId, action: 'sales.lead.contact.update' } });
  const res = await patch('rep', ids.relation, { name: 'Tobias Beispiel', email: 't.beispiel@shop.example', phone: '+49 30 7654321', position: 'Managing director' });
  expect(res.status()).toBe(200);
  expect((await res.json()).changed).toEqual([]);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'sales.lead.contact.update' } })).toBe(before);
});

test('who may: another rep, another tenant and an unknown id are the same 404, an observer is refused, an admin may', { tag: '@smoke' }, async () => {
  const body = { name: 'Changed By Someone', email: '', phone: '', position: '' };
  expect((await patch('rep2', ids.relation, body)).status()).toBe(404);
  expect((await patch('rep', 'does-not-exist', body)).status()).toBe(404);
  // Another tenant's record: the same 404 for the rep and for an admin with company.write.
  expect((await patch('rep', ids.foreign, body)).status()).toBe(404);
  expect((await patch('admin', ids.foreign, body)).status()).toBe(404);
  expect((await prisma.company.findFirst({ where: { orgId: otherOrgId } }))!.contactName).toBe('Foreign Contact');
  expect((await patch('observer', ids.relation, body)).status()).toBe(403);
  expect((await prisma.company.findUnique({ where: { id: ids.company } }))!.contactName).toBe('Tobias Beispiel');

  const byAdmin = await patch('admin', ids.relation, { name: 'Tobias Beispiel', email: 't.beispiel@shop.example', phone: '', position: 'Managing director' });
  expect(byAdmin.status()).toBe(200);
  expect((await byAdmin.json()).changed).toEqual(['phone']);
  expect((await prisma.company.findUnique({ where: { id: ids.company } }))!.contactPhone).toBeNull();
});

test('an address another contact of the account holds is refused', async () => {
  const res = await patch('rep', ids.relation, { name: 'Tobias Beispiel', email: 'Erika@Shop.example', phone: '', position: 'Managing director' });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ code: 'duplicate_email' });
  expect((await prisma.company.findUnique({ where: { id: ids.company } }))!.contactEmail).toBe('t.beispiel@shop.example');
});

test('an unchanged contact still brings a stale lead row back in step', async () => {
  await prisma.user.update({ where: { id: ids.lead }, data: { fullName: 'Stale Name' } });
  const res = await patch('rep', ids.relation, { name: 'Tobias Beispiel', email: 't.beispiel@shop.example', phone: '', position: 'Managing director' });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ changed: [], leadRow: ['name'] });
  expect((await prisma.user.findUnique({ where: { id: ids.lead } }))!.fullName).toBe('Tobias Beispiel');
});

test('bad input is 400; a record without an account is 409 and shows no editor', async ({ page }) => {
  expect((await patch('rep', ids.relation, { name: '', email: 'x@shop.example' })).status()).toBe(400);
  expect((await patch('rep', ids.relation, { name: 'Ok', email: 'not-an-address' })).status()).toBe(400);
  const bare = await patch('rep', ids.bare, { name: 'No Account', email: 'x@shop.example' });
  expect(bare.status()).toBe(409);
  expect(await bare.json()).toEqual({ code: 'no_account' });

  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.rep, PASSWORD, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.bare}`);
  await expect(page.getByTestId('sales-lead-contact-edit')).toHaveCount(0);
  await expect(page.getByTestId('sales-lead')).not.toContainText('import.local');
});
