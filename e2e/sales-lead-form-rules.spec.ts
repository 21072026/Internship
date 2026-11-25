import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The "New lead" form's rules (#3821):
//   • a company name OR a contact name — neither is 400 `name_required`;
//   • a contact alone names the account, a company alone leaves the contact empty;
//   • the rules speak under their fields, not in the banner;
//   • a nameless lead with only a phone is named after its account, never "tel.<digits>";
//   • "Complete follow-up" opens the interaction form on the hand-off's pick.

test.describe.configure({ mode: 'serial' });

const PW = 'LeadFormRules123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DIGITS = String(Date.now()).slice(-6);
let orgId = '';
let repEmail = '';
let repId = '';
const contexts: APIRequestContext[] = [];

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Rules ${STAMP}`, slug: `lead-rules-${STAMP}`, vertical: 'MARKETING' },
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
  repEmail = uniqueEmail(`lead-rules-rep-${STAMP}`).toLowerCase();
  repId = (await seedUser(repEmail, PW, 'MENTOR', `Rules Rep ${STAMP}`, orgId)).id;
});

test.afterAll(async () => {
  for (const c of contexts) await c.dispose();
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.contactPermission.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  await cleanupByEmail(repEmail);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function repApi(playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } }, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  contexts.push(ctx);
  const res = await signInViaApi(ctx, repEmail, PW, { host: MARKETING_HOST, headers: freshIp(`lead-rules-${STAMP}`) });
  expect(res.ok, res.error ?? undefined).toBe(true);
  return ctx;
}

async function leadOf(relationId: string) {
  return prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: relationId },
    select: { company: { select: { name: true, contactName: true } }, mentee: { select: { fullName: true } } },
  });
}

test('company only, contact only, both — and neither is refused', async ({ playwright, baseURL }) => {
  const rep = await repApi(playwright, baseURL);

  // Company only, with only a phone: the contact stays empty and the lead is
  // named after the account — not after its phone key.
  const companyOnly = await rep.post('/api/sales/leads', {
    data: { name: `Acme Company Only ${STAMP}`, country: 'DE', contactPhone: `+49 30 71${DIGITS}` },
  });
  expect(companyOnly.status(), await companyOnly.text()).toBe(201);
  const a = await leadOf((await companyOnly.json()).relationId);
  expect(a.company?.name).toBe(`Acme Company Only ${STAMP}`);
  expect(a.company?.contactName).toBeNull();
  expect(a.mentee.fullName).toBe(`Acme Company Only ${STAMP}`);
  expect(a.mentee.fullName.startsWith('tel.')).toBe(false);

  // Contact only: the account is named after the contact.
  const contactOnly = await rep.post('/api/sales/leads', {
    data: { contactName: `Casey Solo ${STAMP}`, country: 'DE', contactPhone: `+49 30 72${DIGITS}` },
  });
  expect(contactOnly.status(), await contactOnly.text()).toBe(201);
  const b = await leadOf((await contactOnly.json()).relationId);
  expect(b.company?.name).toBe(`Casey Solo ${STAMP}`);
  expect(b.company?.contactName).toBe(`Casey Solo ${STAMP}`);
  expect(b.mentee.fullName).toBe(`Casey Solo ${STAMP}`);

  // Both: each where it belongs.
  const both = await rep.post('/api/sales/leads', {
    data: { name: `Acme Both ${STAMP}`, contactName: `Dana Both ${STAMP}`, country: 'DE', contactEmail: `dana-${STAMP}@shop.example` },
  });
  expect(both.status(), await both.text()).toBe(201);
  const c = await leadOf((await both.json()).relationId);
  expect(c.company?.name).toBe(`Acme Both ${STAMP}`);
  expect(c.company?.contactName).toBe(`Dana Both ${STAMP}`);
  expect(c.mentee.fullName).toBe(`Dana Both ${STAMP}`);

  // Neither (blank counts as missing): 400 with its own code, nothing written.
  const before = await prisma.company.count({ where: { orgId } });
  for (const data of [{ contactPhone: `+49 30 73${DIGITS}` }, { name: '  ', contactName: '', contactPhone: `+49 30 73${DIGITS}` }]) {
    const none = await rep.post('/api/sales/leads', { data });
    expect(none.status()).toBe(400);
    expect((await none.json()).code).toBe('name_required');
  }
  expect(await prisma.company.count({ where: { orgId } })).toBe(before);
});

test('the form says what is missing under the fields, and a contact alone creates the lead', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PW, '/sales');
  await gotoSettled(page, '/sales');
  await page.getByTestId('new-lead-button').click();
  const dialog = page.getByTestId('new-lead-dialog');

  // Nothing filled: both rules speak under their fields; no banner, no request.
  await dialog.getByTestId('new-lead-submit').click();
  await expect(dialog.getByText('Enter a company name or a contact name.')).toBeVisible();
  await expect(dialog.getByText('Enter an e-mail address or a phone number.')).toBeVisible();
  await expect(dialog.getByTestId('new-lead-error')).toHaveCount(0);
  await expect(dialog.locator('#new-lead-name')).toHaveAttribute('aria-invalid', 'true');

  // A contact name clears the name rule as it is typed; the contact rule stays.
  await dialog.locator('#new-lead-contact-name').fill(`Erin Form ${STAMP}`);
  await expect(dialog.getByText('Enter a company name or a contact name.')).toHaveCount(0);
  await expect(dialog.getByText('Enter an e-mail address or a phone number.')).toBeVisible();

  await dialog.locator('#new-lead-country').fill('DE');
  await dialog.locator('#new-lead-contact-phone').fill(`+49 40 74${DIGITS}`);
  await expect(dialog.getByText('Enter an e-mail address or a phone number.')).toHaveCount(0);
  await dialog.getByTestId('new-lead-submit').click();
  await expect(dialog.getByTestId('new-lead-created')).toBeVisible();
  const company = await prisma.company.findFirstOrThrow({ where: { orgId, name: `Erin Form ${STAMP}` } });
  expect(company.contactName).toBe(`Erin Form ${STAMP}`);
});

test('completing a handed-off follow-up opens the interaction form on the hand-off\'s pick', async ({ page }) => {
  test.slow();
  const relation = await prisma.mentorshipRelation.findFirstOrThrow({
    where: { orgId, mentorId: repId, company: { name: `Acme Both ${STAMP}` } },
    select: { id: true },
  });
  const setNote = (note: string) =>
    prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { nextActionAt: new Date(), nextActionNote: note } });

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PW, '/sales');
  const form = page.getByTestId('sales-lead-log-interaction');
  const type = form.getByRole('combobox');

  // The note a hand-off composes: the pick's label, then the sender's words — in the sender's language.
  // Since #3903 the page shows the words alone (the pick is its own label), so the form gets the words.
  const cases: [string, string, string][] = [
    ['Send an e-mail: the pricing sheet', 'Email', 'the pricing sheet'],
    ['Randevu yapılacak: Salı', 'Meeting', 'Salı'],
    ['App-Demo zeigen', 'Meeting', ''],
    // `other`, or a follow-up the rep wrote: a call, as before, with the note as written.
    ['Ask about the trial', 'Call', 'Ask about the trial'],
  ];
  for (const [note, expected, words] of cases) {
    await setNote(note);
    await gotoSettled(page, `/sales/leads/${relation.id}`);
    await page.getByTestId('follow-up-complete').click();
    await expect(type, note).toHaveValue(expected);
    await expect(form.locator('textarea')).toHaveValue(words);
  }
  // Nothing was logged on the way.
  expect(await prisma.interactionLog.count({ where: { relationId: relation.id } })).toBe(0);
});
