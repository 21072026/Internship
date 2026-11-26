import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// "My feedback" (#3877, src/lib/myFeedbackReports.ts): a person reads back the
// reports they sent — their own only, without the screenshot, replay or
// console/network context — and sees the team's note once an admin sends one.
// Another person's report is a 404. A security boundary, so it is in the smoke set.
// SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'MyFeedback123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const emails: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
let orgId = '';
let otherOrgId = '';

async function person(label: string, role: 'ADMIN' | 'MENTEE', org: string) {
  const email = uniqueEmail(`myfb-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `MyFb ${label} ${STAMP}`, org);
  ids[label] = user.id;
  mail[label] = email;
}

async function report(label: string, userId: string, org: string, description: string) {
  const row = await prisma.supportReport.create({
    data: {
      orgId: org,
      userId,
      type: 'BUG',
      description,
      url: `https://app.example.test/portal/goals?token=hidden-${STAMP}`,
      appVersion: 'e2e',
      env: 'test',
      userAgent: 'e2e-agent',
      viewport: '1280x720',
      context: { consoleErrors: [`console-secret-${STAMP}`], failedRequests: [] },
      contactAllowed: true,
    },
  });
  ids[label] = row.id;
}

async function jar(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, label: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await signInViaApi(ctx, mail[label], PW, { headers: freshIp(`myfb-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Feedback ${STAMP}`, slug: `myfb-${STAMP}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Acme Feedback Other ${STAMP}`, slug: `myfb-o-${STAMP}` } })).id;
  await person('me', 'MENTEE', orgId);
  await person('colleague', 'MENTEE', orgId);
  await person('admin', 'ADMIN', orgId);
  await person('foreign', 'MENTEE', otherOrgId);
  await report('mine', ids.me, orgId, `The goals page froze ${STAMP}`);
  await report('theirs', ids.colleague, orgId, `Colleague's report ${STAMP}`);
  await report('foreignReport', ids.foreign, otherOrgId, `Other org's report ${STAMP}`);
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [ids.me, ids.colleague, ids.admin, ids.foreign].filter(Boolean) } } }).catch(() => {});
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: [ids.me, ids.colleague, ids.admin, ids.foreign].filter(Boolean) } } }).catch(() => {});
  await prisma.supportReport.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a person reads back their own reports only, without the triage material; anyone else\'s is a 404', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.get('/api/support/reports')).status()).toBe(401);
  await anon.dispose();

  const me = await jar(playwright, baseURL, 'me');
  const list = await me.get('/api/support/reports');
  expect(list.status()).toBe(200);
  const reports = (await list.json()).reports as Array<Record<string, unknown>>;
  expect(reports.map((r) => r.id)).toEqual([ids.mine]);
  // What they wrote and what became of it — never the context, files, agent or host.
  expect(Object.keys(reports[0]).sort()).toEqual(['createdAt', 'description', 'id', 'path', 'reporterNote', 'reporterNoteAt', 'status', 'type', 'updatedAt']);
  expect(reports[0]).toMatchObject({ path: '/portal/goals', status: 'NEW', description: `The goals page froze ${STAMP}` });
  expect(JSON.stringify(reports)).not.toContain(`console-secret-${STAMP}`);
  expect(JSON.stringify(reports)).not.toContain('hidden-');

  expect((await me.get(`/api/support/reports/${ids.mine}`)).status()).toBe(200);
  for (const other of [ids.theirs, ids.foreignReport, 'does-not-exist']) {
    const res = await me.get(`/api/support/reports/${other}`);
    expect(res.status(), other).toBe(404);
  }
  await me.dispose();
});

test('the team\'s note reaches the reporter\'s list, and the page shows it with the status', async ({ playwright, baseURL, page }) => {
  test.slow();
  const admin = await jar(playwright, baseURL, 'admin');
  const patched = await admin.patch(`/api/admin/support/reports/${ids.mine}`, {
    data: { status: 'RESOLVED', notifyReporter: true, note: `Fixed in the next release ${STAMP}` },
  });
  expect(patched.status()).toBe(200);
  await admin.dispose();
  const row = await prisma.supportReport.findUniqueOrThrow({ where: { id: ids.mine }, select: { reporterNote: true, reporterNoteAt: true } });
  expect(row.reporterNote).toBe(`Fixed in the next release ${STAMP}`);
  expect(row.reporterNoteAt).not.toBeNull();

  await signInAndSettle(page, mail.me, PW, '/portal');
  await gotoSettled(page, '/account');
  await page.getByTestId('account-my-feedback').click();
  await page.waitForURL((u) => u.pathname === '/account/feedback');
  const card = page.getByTestId(`my-feedback-${ids.mine}`);
  await expect(card).toContainText(`The goals page froze ${STAMP}`);
  await expect(card).toContainText('/portal/goals');
  await expect(card.getByTestId('my-feedback-status')).toHaveText('Resolved');
  await expect(card.getByTestId('my-feedback-reply')).toContainText(`Fixed in the next release ${STAMP}`);
  await expect(page.getByTestId(`my-feedback-${ids.theirs}`)).toHaveCount(0);
});

test('a status change rings the reporter\'s bell in the app, linked to the report; no change, no bell (#3878)', async ({ playwright, baseURL, page }) => {
  test.slow();
  const bells = () => prisma.notification.findMany({ where: { userId: ids.me, type: 'support_report.updated' }, select: { link: true } });
  const before = (await bells()).length;
  const admin = await jar(playwright, baseURL, 'admin');
  // A change of status without the mail (and with contact not even asked for).
  expect((await admin.patch(`/api/admin/support/reports/${ids.mine}`, { data: { status: 'IN_PROGRESS' } })).status()).toBe(200);
  await expect.poll(async () => (await bells()).length).toBe(before + 1);
  expect((await bells()).every((b) => b.link === `/account/feedback#report-${ids.mine}`)).toBe(true);
  // The same status again, no note: nothing new happened, so no bell.
  expect((await admin.patch(`/api/admin/support/reports/${ids.mine}`, { data: { status: 'IN_PROGRESS' } })).status()).toBe(200);
  await page.waitForTimeout(500);
  expect((await bells()).length).toBe(before + 1);
  await admin.dispose();
  // Only the reporter hears it.
  expect(await prisma.notification.count({ where: { userId: ids.colleague, type: 'support_report.updated' } })).toBe(0);

  // The bell's link lands on the report in the list.
  await signInAndSettle(page, mail.me, PW, '/portal');
  await gotoSettled(page, `/account/feedback#report-${ids.mine}`);
  await expect(page.getByTestId(`my-feedback-${ids.mine}`).getByTestId('my-feedback-status')).toHaveText('Being worked on');
});

test('"My feedback" is in the account menu of every role shell and opens the page (#3910)', async ({ page }) => {
  // A mentee's portal and an admin's shell render the same AccountMenu.
  for (const [label, landing] of [['me', '/portal'], ['admin', '/admin']] as const) {
    await page.context().clearCookies();
    await signInAndSettle(page, mail[label], PW, landing);
    await page.getByTestId('account-menu-button').first().click();
    const item = page.getByTestId('account-menu-feedback').first();
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('role', 'menuitem');
    await item.click();
    await page.waitForURL((u) => u.pathname === '/account/feedback', { timeout: 20_000 });
  }
});

test('the page says how far along it is and filters by outcome; "will not be changed" is not completed (#3929)', async ({ page }) => {
  // The colleague's own reports only: one per status (their first report stays NEW).
  const statuses = ['TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'RESOLVED', 'WONT_FIX'] as const;
  for (const [i, status] of statuses.entries()) {
    await report(`c-${i}`, ids.colleague, orgId, `Colleague ${status} ${i} ${STAMP}`);
    await prisma.supportReport.update({ where: { id: ids[`c-${i}`] }, data: { status } });
  }
  await signInAndSettle(page, mail.colleague, PW, '/portal');
  await gotoSettled(page, '/account/feedback');
  // 6 reports: NEW + TRIAGED + IN_PROGRESS waiting, 2 RESOLVED, 1 WONT_FIX.
  await expect(page.getByTestId('my-feedback-progress')).toHaveText('2 of 6 completed, 3 waiting · 1 will not be changed');
  await expect(page.locator('li[id^="report-"]')).toHaveCount(6);

  await page.getByTestId('my-feedback-filter-done').click();
  await expect(page.getByTestId('my-feedback-filter-done')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('li[id^="report-"]')).toHaveCount(2);
  await expect(page.getByTestId('my-feedback-status')).toHaveText(['Resolved', 'Resolved']);
  expect(new URL(page.url()).searchParams.get('status')).toBe('done');

  await page.getByTestId('my-feedback-filter-open').click();
  await expect(page.locator('li[id^="report-"]')).toHaveCount(3);
  await page.getByTestId('my-feedback-filter-wontFix').click();
  await expect(page.locator('li[id^="report-"]')).toHaveCount(1);
  // The filter survives a reload; nobody else's report is ever on the list.
  await page.reload();
  await expect(page.getByTestId('my-feedback-filter-wontFix')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('li[id^="report-"]')).toHaveCount(1);
  await page.getByTestId('my-feedback-filter-all').click();
  await expect(page.getByText(`The goals page froze ${STAMP}`)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('status')).toBeNull();
});

test('an admin links the PRs a report was worked in; the reporter never sees them (#3928)', { tag: '@smoke' }, async ({ playwright, baseURL, page }) => {
  const pr = (n: number) => `https://github.com/21072026/Internship/pull/${n}`;
  const admin = await jar(playwright, baseURL, 'admin');
  const add = (id: string, url: string) => admin.post(`/api/admin/support/reports/${id}/pr-links`, { data: { url } });

  // Only a PR of this repository, in one canonical form; the same PR twice is one link.
  expect((await (await add(ids.mine, 'https://github.com/someone/else/pull/1')).json()).code).toBe('wrong_repo');
  expect((await (await add(ids.mine, `${pr(1)}`.replace('/pull/', '/issues/'))).json()).code).toBe('invalid_pr_url');
  const first = await add(ids.mine, `${pr(3934)}/`);
  expect(first.status()).toBe(200);
  expect(((await first.json()).prLinks as { url: string }[]).map((l) => l.url)).toEqual([pr(3934)]);
  expect((await (await add(ids.mine, pr(3934))).json()).unchanged).toBe(true);
  expect((await add(ids.mine, pr(3940))).status()).toBe(200);
  // Another org's report is a 404, like a missing one.
  expect((await add(ids.foreignReport, pr(1))).status()).toBe(404);
  const audits = await prisma.auditLog.count({ where: { targetId: ids.mine, action: 'support_report.pr_link_added' } });
  expect(audits).toBe(2);

  // The inbox shows them and filters by them.
  const withPr = (await (await admin.get('/api/admin/support/reports?pr=with')).json()).reports as { id: string; prLinks: { number: number }[] }[];
  expect(withPr.map((r) => r.id)).toEqual([ids.mine]);
  expect(withPr[0].prLinks.map((l) => l.number)).toEqual([3934, 3940]);
  const without = (await (await admin.get('/api/admin/support/reports?pr=without')).json()).reports as { id: string }[];
  expect(without.map((r) => r.id)).not.toContain(ids.mine);

  // The reporter's list and report never carry them; they cannot write them either.
  const me = await jar(playwright, baseURL, 'me');
  for (const path of ['/api/support/reports', `/api/support/reports/${ids.mine}`]) {
    const body = await (await me.get(path)).text();
    expect(body, path).not.toContain('/pull/');
    expect(body, path).not.toContain('prLinks');
  }
  expect((await me.post(`/api/admin/support/reports/${ids.mine}/pr-links`, { data: { url: pr(1) } })).status()).toBe(403);
  await me.dispose();

  // The admin's report page: the card lists them and removes one.
  // The page reads the context in the shape the server stores (feedbackContext.ts); this file's fixture writes bare strings.
  await prisma.supportReport.update({ where: { id: ids.mine }, data: { context: { consoleErrors: [], failedRequests: [] } } });
  await signInAndSettle(page, mail.admin, PW, '/admin');
  await gotoSettled(page, `/admin/support/reports/${ids.mine}`);
  const card = page.getByTestId('report-pr-links');
  await expect(card.getByTestId('report-pr-3934')).toHaveAttribute('href', pr(3934));
  await card.getByTestId('report-pr-remove-3940').click();
  await expect(card.getByTestId('report-pr-3940')).toHaveCount(0);
  await card.getByTestId('report-pr-url').fill('https://example.com/x');
  await card.getByTestId('report-pr-add').click();
  await expect(card.getByTestId('report-pr-error')).toBeVisible();
  await admin.dispose();
});
