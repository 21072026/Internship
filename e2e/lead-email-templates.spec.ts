import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * E-mail templates on a lead (#3908): an admin writes one on
 * /admin/message-templates (channel "E-mail templates", subject per language),
 * a rep picks it next to the lead's address and the link becomes a mailto:
 * with the subject and text filled in. The pool is the org's: another org's
 * e-mail template is not offered, and the in-app composer's pool does not get
 * the e-mail ones. SYNTHETIC ONLY.
 */

const PW = 'EmailTpl3908!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const mail = { admin: uniqueEmail(`et-admin-${STAMP}`), rep: uniqueEmail(`et-rep-${STAMP}`), otherAdmin: uniqueEmail(`et-other-${STAMP}`) };
const orgIds: string[] = [];
let relId = '';

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

test.beforeAll(async () => {
  for (const slug of ['a', 'b']) {
    const org = await prisma.organization.create({ data: { name: `Acme Mail ${slug} ${STAMP}`, slug: `et-${slug}-${STAMP}`, vertical: 'MARKETING' } });
    orgIds.push(org.id);
    await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })) });
  }
  await seedUser(mail.admin, PW, 'ADMIN', `ET Admin ${STAMP}`, orgIds[0]);
  const rep = await seedUser(mail.rep, PW, 'MENTOR', `Rita Rep`, orgIds[0]);
  await seedUser(mail.otherAdmin, PW, 'ADMIN', `ET Other ${STAMP}`, orgIds[1]);
  const company = await prisma.company.create({ data: { orgId: orgIds[0], name: 'Example Shop GmbH', contactName: 'Clara Example', contactEmail: 'clara@shop.example' } });
  const lead = await prisma.user.create({
    data: { orgId: orgIds[0], email: `et-lead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: 'Clara Example', skills: [], companyId: company.id },
  });
  relId = (await prisma.mentorshipRelation.create({ data: { orgId: orgIds[0], mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'LEAD_CONTACTED' } })).id;
});

test.afterAll(async () => {
  await prisma.messageTemplate.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds }, role: 'MENTEE' } }).catch(() => {});
  for (const e of Object.values(mail)) await cleanupByEmail(e);
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page, email: string, landing: string) {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, landing);
}

test('an admin writes an e-mail template; a rep picks it and the mail link carries subject and text', async ({ page, browser }) => {
  test.slow();
  // Another org's e-mail template, which must never be offered here.
  const other = await browser.newContext({ extraHTTPHeaders: host, locale: 'en-GB' });
  const otherPage = await other.newPage();
  await signIn(otherPage, mail.otherAdmin, '/admin');
  const foreign = await otherPage.request.post('/api/admin/message-templates', {
    data: { channel: 'email', translations: { en: `Foreign body ${STAMP}` }, subjects: { en: `Foreign subject ${STAMP}` } },
  });
  expect(foreign.status()).toBe(201);
  await other.close();

  // The admin screen: the e-mail tab, a subject and a body with placeholders.
  await signIn(page, mail.admin, '/admin');
  await gotoSettled(page, '/admin/message-templates');
  await page.getByTestId('message-template-channel-email').click();
  await expect(page.getByTestId('message-template-channel-email')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('new-message-template-subject-en').fill('Your offer, {company}');
  await page.getByTestId('new-message-template-en').fill('Hello {name},\nhere is the offer.\nBest, {sender}');
  await page.getByTestId('create-message-template').click();
  await expect.poll(() => prisma.messageTemplate.count({ where: { orgId: orgIds[0], channel: 'email' } }), { timeout: 10_000 }).toBe(1);
  const row = await prisma.messageTemplate.findFirstOrThrow({ where: { orgId: orgIds[0], channel: 'email' } });
  expect(row.subjects).toEqual({ en: 'Your offer, {company}' });
  await expect(page.getByTestId(`message-template-subject-${row.id}`)).toHaveText('Your offer, {company}');
  // The in-app tab does not list it.
  await page.getByTestId('message-template-channel-message').click();
  await expect(page.getByTestId(`message-template-${row.id}`)).toHaveCount(0);

  // The rep's lead page.
  await page.context().clearCookies();
  await signIn(page, mail.rep, '/sales');
  // The composer's pool has no e-mail template; the e-mail pool is this org's only.
  const composer = (await (await page.request.get('/api/message-templates')).json()).templates as { id: string }[];
  expect(composer.map((x) => x.id)).not.toContain(row.id);
  const pool = (await (await page.request.get('/api/message-templates?channel=email')).json()).templates as { title: string }[];
  expect(pool.map((x) => x.title)).toEqual([row.title]);

  await gotoSettled(page, `/sales/leads/${relId}`);
  const link = page.getByTestId('sales-lead-email-link');
  await expect(link).toHaveAttribute('href', 'mailto:clara@shop.example');
  const picker = page.getByTestId('sales-lead-email-template');
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption(row.id);
  const href = (await link.getAttribute('href'))!;
  const url = new URL(href);
  expect(url.protocol).toBe('mailto:');
  expect(url.pathname).toBe('clara@shop.example');
  expect(url.searchParams.get('subject')).toBe('Your offer, Example Shop GmbH');
  expect(url.searchParams.get('body')).toBe('Hello Clara Example,\r\nhere is the offer.\r\nBest, Rita Rep');

  // Opening it logs the e-mail as usual and counts the template's use.
  await page.evaluate(() =>
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a[href^="mailto:"]')) e.preventDefault();
    }, true),
  );
  await link.click();
  await expect(page.getByTestId('sales-lead-log-interaction').getByRole('combobox')).toHaveValue('Email');
  await expect.poll(async () => (await prisma.messageTemplate.findUniqueOrThrow({ where: { id: row.id } })).useCount).toBe(1);
});
