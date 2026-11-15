import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * Click-to-call on a MARKETING lead (#3748): the mentor page's ContactActions
 * reused on /sales/leads/[id] and on the admin's lead view.
 *
 *   - On the lead page the contact card's tel: link (#3741) is the one way in:
 *     the device dials (the navigation is stopped here), then "Did you reach
 *     them?" — "No" logs nothing, "Add a note" opens the call draft and logs
 *     nothing, "Yes" logs a Call through POST /api/interactions and the page's
 *     interaction list shows it after the refresh.
 *   - A colleague rep sees neither the record (404) nor the buttons, and the API
 *     refuses them a log on it: 403, no row (@smoke — the security case).
 *   - On /admin/candidates/[id] an admin holding relation.write gets the buttons;
 *     an OBSERVER admin, whom the route would refuse, does not (the flag is the
 *     server's).
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, example addresses and numbers.
 */

const PW = 'ClickToCall123!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const mail = { rep: uniqueEmail('c2c-rep'), rep2: uniqueEmail('c2c-rep2'), admin: uniqueEmail('c2c-admin'), observer: uniqueEmail('c2c-observer') };
let orgId = '';
const ids = { relation: '', lead: '', fresh: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Calls ${STAMP}`, slug: `c2c-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId })) });
  const rep = await seedUser(mail.rep, PW, 'MENTOR', `C2C Rep ${STAMP}`, orgId);
  await seedUser(mail.rep2, PW, 'MENTOR', `C2C Rep2 ${STAMP}`, orgId);
  await seedUser(mail.admin, PW, 'ADMIN', `C2C Admin ${STAMP}`, orgId);
  const observer = await seedUser(mail.observer, PW, 'ADMIN', `C2C Observer ${STAMP}`, orgId);
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  const company = await prisma.company.create({
    data: { orgId, name: `Example Calls ${STAMP}`, contactName: 'Clara Example', contactPhone: '+49 30 7654321' },
  });
  const lead = await prisma.user.create({
    data: { orgId, email: `c2c-lead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: 'Clara Example', phone: '+49 30 7654321', skills: [], companyId: company.id },
  });
  ids.lead = lead.id;
  ids.relation = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'LEAD_CONTACTED' } })).id;
  // A first-stage lead for the first-contact move (#3746).
  const freshCompany = await prisma.company.create({ data: { orgId, name: `Example Fresh ${STAMP}`, contactName: 'Frida Example', contactPhone: '+49 30 1112223' } });
  const freshLead = await prisma.user.create({
    data: { orgId, email: `c2c-fresh-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: 'Frida Example', phone: '+49 30 1112223', skills: [], companyId: freshCompany.id },
  });
  ids.fresh = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: rep.id, menteeId: freshLead.id, companyId: freshCompany.id, pipelineStatus: 'LEAD_NEW' } })).id;
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } });
  await prisma.setting.deleteMany({ where: { orgId } });
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } });
  for (const email of Object.values(mail)) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId } });
  await prisma.pipelineStage.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

/** The device's tel: navigation is stopped and recorded; the page's own click handler still runs. */
async function stopTelNavigation(page: Page) {
  await page.evaluate(() => {
    const dialled: string[] = [];
    (window as unknown as { __dialled: string[] }).__dialled = dialled;
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[href^="tel:"]');
      if (a) {
        e.preventDefault();
        dialled.push(a.getAttribute('href') ?? '');
      }
    }, true);
  });
}
const dialled = (page: Page) => page.evaluate(() => (window as unknown as { __dialled: string[] }).__dialled);
const callCount = () => prisma.interactionLog.count({ where: { relationId: ids.relation, type: 'Call' } });

test('the rep calls from the lead page: No and Add a note log nothing, Yes logs a Call and the list shows it', async ({ page, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.relation}`);
  await stopTelNavigation(page);
  const phone = page.getByTestId('sales-lead-phone-link');
  // One way in for one number: the tel: link, no second Call button.
  await expect(phone).toHaveAttribute('href', 'tel:+49307654321');
  await expect(page.getByTestId('contact-call')).toHaveCount(0);

  // "No": the number was dialled, nothing is logged.
  await phone.click();
  expect(await dialled(page)).toEqual(['tel:+49307654321']);
  await page.getByTestId('contact-reached-no').click();
  await expect(page.getByTestId('contact-reached')).toHaveCount(0);
  expect(await callCount()).toBe(0);

  // "Add a note": the page's interaction form opens as a call — and still nothing is logged.
  await phone.click();
  await page.getByTestId('contact-reached-note').click();
  const form = page.getByTestId('sales-lead-log-interaction');
  await expect(form.getByRole('combobox')).toHaveValue('Call');
  await expect(page.getByTestId('contact-reached')).toHaveCount(0);
  expect(await callCount()).toBe(0);
  await form.getByRole('button', { name: /Cancel/i }).click();

  // "Yes": one Call interaction, through the route, and the list shows it.
  await phone.click();
  await page.getByTestId('contact-reached-yes').click();
  await expect.poll(callCount, { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('sales-lead-interactions')).toContainText('Phone call', { timeout: 10_000 });
});

test("a colleague rep reads the record but gets no log on it", { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const before = await prisma.interactionLog.count({ where: { relationId: ids.relation } });
  // The page: the team view opens someone else's record read-only (src/lib/salesBookRule.ts),
  // and the phone is a plain tel: link — no "Did you reach them?" behind it.
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, mail.rep2, PW, '/sales');
  const res = await page.goto(`/sales/leads/${ids.relation}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('sales-lead-readonly')).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  await stopTelNavigation(page);
  const phone = page.getByTestId('sales-lead-phone-link');
  await expect(phone).toHaveAttribute('href', 'tel:+49307654321');
  await phone.click();
  expect(await dialled(page)).toEqual(['tel:+49307654321']);
  await expect(page.getByTestId('contact-reached')).toHaveCount(0);
  await expect(page.getByTestId('sales-lead-log-interaction')).toHaveCount(0);

  // The route the question posts to refuses them too.
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host });
  try {
    expect((await signInViaApi(ctx, mail.rep2, PW, { host: MARKETING_HOST })).ok).toBe(true);
    const post = await ctx.post('/api/interactions', {
      data: { relationId: ids.relation, date: new Date().toISOString(), type: 'Call', notes: 'Phone call' },
    });
    expect([403, 404]).toContain(post.status());
  } finally {
    await ctx.dispose();
  }
  expect(await prisma.interactionLog.count({ where: { relationId: ids.relation } })).toBe(before);
});

test('the admin lead view: buttons for an admin who may log, none for an observer', async ({ page, browser, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, mail.admin, PW, '/admin');
  await gotoSettled(page, `/admin/candidates/${ids.lead}`);
  await expect(page.getByTestId('candidate-contact-actions')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('contact-call')).toBeVisible();

  const observer = await browser.newContext({ extraHTTPHeaders: host });
  try {
    const p = await observer.newPage();
    await p.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await signInAndSettle(p, mail.observer, PW, '/admin');
    await gotoSettled(p, `/admin/candidates/${ids.lead}`);
    await expect(p.getByText('Clara Example').first()).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('candidate-contact-actions')).toHaveCount(0);
    const body = await (await p.request.get(`/api/users/${ids.lead}`)).json();
    expect(body.user.canLogInteraction).toBe(false);
  } finally {
    await observer.close();
  }
});

// #3746 × #3748: a "Yes" on a first-stage lead goes through the same write as the
// form, so the first-contact rule moves it — and the question says so, with the
// form's own toast and Undo (useStageAdvanceToast), and the stage badge follows.
async function setFirstContactAdvance(value: 'on' | 'off') {
  await prisma.setting.deleteMany({ where: { orgId, key: 'firstContactAutoAdvance', programId: null } });
  await prisma.setting.create({ data: { orgId, key: 'firstContactAutoAdvance', value } });
}
const stageOf = async (id: string) => (await prisma.mentorshipRelation.findUnique({ where: { id }, select: { pipelineStatus: true } }))?.pipelineStatus;

async function callAndSayYes(page: Page, baseURL: string, beforeCall?: () => Promise<void>) {
  await page.context().setExtraHTTPHeaders(host);
  await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL }]);
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.fresh}`);
  await beforeCall?.();
  await stopTelNavigation(page);
  await page.getByTestId('sales-lead-phone-link').click();
  await page.getByTestId('contact-reached-yes').click();
}

test('switched on: Yes on a first-stage lead moves it, the toast names the stage, Undo moves it back', async ({ page, baseURL }) => {
  await setFirstContactAdvance('on');
  await prisma.mentorshipRelation.update({ where: { id: ids.fresh }, data: { pipelineStatus: 'LEAD_NEW' } });
  const before = (await prisma.interactionLog.count({ where: { relationId: ids.fresh } }));
  let firstLabel = '';
  await callAndSayYes(page, baseURL!, async () => {
    firstLabel = (await page.getByTestId('sales-lead-stage').textContent())!.trim();
  });
  await expect.poll(() => stageOf(ids.fresh), { timeout: 10_000 }).toBe('LEAD_CONTACTED');
  expect(await prisma.interactionLog.count({ where: { relationId: ids.fresh } })).toBe(before + 1);
  // The page re-read itself: the badge shows the new stage, and the toast names the same one.
  const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  const toastText = (await toast.textContent()) ?? '';
  await expect(page.getByText('Contact logged')).toHaveCount(0);
  // The page re-read itself: the badge leaves the first stage, and the toast named that new stage.
  const badge = page.getByTestId('sales-lead-stage');
  await expect.poll(async () => (await badge.textContent())?.trim(), { timeout: 10_000 }).not.toBe(firstLabel);
  const label = (await badge.textContent())!.trim();
  expect(toastText).toContain(label);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stageOf(ids.fresh), { timeout: 10_000 }).toBe('LEAD_NEW');
});

test('switched off: Yes logs the call and the toast only says it was logged', async ({ page, baseURL }) => {
  await setFirstContactAdvance('off');
  await prisma.mentorshipRelation.update({ where: { id: ids.fresh }, data: { pipelineStatus: 'LEAD_NEW' } });
  const before = (await prisma.interactionLog.count({ where: { relationId: ids.fresh } }));
  await callAndSayYes(page, baseURL!);
  await expect.poll(() => prisma.interactionLog.count({ where: { relationId: ids.fresh } }), { timeout: 10_000 }).toBe(before + 1);
  await expect(page.getByText('Contact logged')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(await stageOf(ids.fresh)).toBe('LEAD_NEW');
});
