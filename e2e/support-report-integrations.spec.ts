import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';
import { E2E_GITHUB_MOCK_PORT } from '../playwright.config';
import { BUILT_IN_RETENTION_ENTRIES } from '../src/lib/retentionEntries';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3132: what happens after a bug report lands — the admins are told, an
// admin can push it to GitHub (and nothing personal goes with it), the
// reporter is told about a status change only if they allowed contact, and
// the report and its files are gone after the retention window.

const mock = `http://127.0.0.1:${E2E_GITHUB_MOCK_PORT}`;

async function fileReport(request: APIRequestContext, description: string, contactAllowed: boolean) {
  const res = await request.post('/api/support/reports', {
    multipart: {
      type: 'BUG',
      description,
      contactAllowed: String(contactAllowed),
      url: 'https://tenant-brand.example/portal/profile?ref=***',
      viewport: '1280x800',
      context: JSON.stringify({ failedRequests: [{ method: 'POST', url: '/api/profile', status: 500, durationMs: 40, requestId: 'req-e2e-1', at: new Date().toISOString() }] }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

test('bug report integrations: admin mail, public-safe GitHub issue, reporter notice, retention', { tag: '@smoke' }, async ({ browser, request }) => {
  test.slow();
  const userEmail = uniqueEmail('fbi-user');
  const adminEmail = uniqueEmail('fbi-admin');
  const pw = 'FeedbackIntegr123';
  await seedUser(userEmail, pw, 'MENTEE', 'Integration User');
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Integration Admin');
  const userCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    await fetch(`${mock}/__visibility`, { method: 'POST', body: JSON.stringify({ private: false }) });
    const userPage = await userCtx.newPage();
    await signInAndSettle(userPage, userEmail, pw, '/portal');
    const secretWords = `Saving my profile fails, call me at ${userEmail}`;
    const silentId = await fileReport(userPage.request, secretWords, false);
    const openId = await fileReport(userPage.request, 'Second report, contact me', true);

    // 1. Every admin of the org is mailed about a new report (after the response).
    await expect
      .poll(() => prisma.emailLog.count({ where: { to: adminEmail, category: 'support-report' } }), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // 2. The reporter cannot reach the GitHub route; an anonymous caller neither.
    expect((await userPage.request.get(`/api/admin/support/reports/${silentId}/github`)).status()).toBe(401);
    expect((await request.post(`/api/admin/support/reports/${silentId}/github`, { data: { title: 'x', body: 'y' } })).status()).toBe(401);

    // 3. The admin previews the draft: technical facts only.
    const adminPage = await adminCtx.newPage();
    await signInAndSettle(adminPage, adminEmail, pw, '/admin');
    const preview = await (await adminPage.request.get(`/api/admin/support/reports/${silentId}/github`)).json();
    expect(preview).toMatchObject({ configured: true, repo: 'example-org/example-repo', isPrivate: false, issueUrl: null });
    expect(preview.draft.body).toContain('`/portal/profile?ref=***`');
    expect(preview.draft.body).toContain('`req-e2e-1`');
    for (const leak of [secretWords, userEmail, 'Integration User', 'tenant-brand']) expect(preview.draft.body).not.toContain(leak);

    // 4. …and creates it from the detail screen, with the public-repo warning shown.
    await gotoSettled(adminPage, `/admin/support/reports/${silentId}`);
    const card = adminPage.getByTestId('report-github');
    await card.getByTestId('report-github-create').click();
    await expect(card.getByTestId('report-github-public')).toBeVisible();
    await card.getByTestId('report-github-submit').click();
    await expect(card.getByTestId('report-github-link')).toHaveAttribute('href', /^https:\/\/github\.com\/example-org\/example-repo\/issues\/\d+$/);
    const stored = await prisma.supportReport.findUniqueOrThrow({ where: { id: silentId } });
    expect(stored.githubIssueUrl).toMatch(/\/issues\/\d+$/);
    const { issues } = await (await fetch(`${mock}/__issues`)).json();
    const sent = issues[issues.length - 1];
    expect(sent.body).not.toContain(secretWords);
    expect(sent.body).not.toContain(userEmail);
    // One issue per report.
    const again = await adminPage.request.post(`/api/admin/support/reports/${silentId}/github`, { data: { title: 'again', body: 'again' } });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('already_linked');

    // A GitHub failure releases the claim, so the admin can retry.
    await fetch(`${mock}/__fail`, { method: 'POST', body: JSON.stringify({ count: 1 }) });
    const failed = await adminPage.request.post(`/api/admin/support/reports/${openId}/github`, { data: { title: 't', body: 'b' } });
    expect(failed.status()).toBe(502);
    expect((await prisma.supportReport.findUniqueOrThrow({ where: { id: openId } })).githubIssueUrl).toBeNull();

    // 5. Telling the reporter: refused when they did not allow contact…
    const refused = await adminPage.request.patch(`/api/admin/support/reports/${silentId}`, { data: { status: 'RESOLVED', notifyReporter: true } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe('contact_not_allowed');
    // …and sent, with the note, when they did (through the UI).
    await gotoSettled(adminPage, `/admin/support/reports/${openId}`);
    await adminPage.getByTestId('report-status-select').selectOption('RESOLVED');
    await adminPage.getByTestId('report-notify-reporter').check();
    await adminPage.getByTestId('report-status-note').fill('Fixed in the next release.');
    await adminPage.getByTestId('report-status-save').click();
    await expect
      .poll(() => prisma.emailLog.count({ where: { to: userEmail, category: 'support-report-update' } }), { timeout: 15_000 })
      .toBe(1);
    expect((await prisma.supportReport.findUniqueOrThrow({ where: { id: openId } })).status).toBe('RESOLVED');

    // 6. Retention: a report past the window goes, with its files; a fresh one stays.
    const old = await prisma.supportReport.create({
      data: {
        orgId: stored.orgId, userId: stored.userId, type: 'BUG', description: 'old', url: '/x', appVersion: 'v', env: 'preview',
        userAgent: 'ua', viewport: '1x1', contactAllowed: false, createdAt: new Date(Date.now() - 100 * 86_400_000),
        files: { create: [{ kind: 'SCREENSHOT', filename: 's.jpg', contentType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]) }] },
      },
      include: { files: true },
    });
    const entry = BUILT_IN_RETENTION_ENTRIES.find((e) => e.key === 'supportReport')!;
    expect(entry.defaultDays).toBe(90);
    const now = new Date();
    const outcome = await entry.run({ now, cutoff: new Date(now.getTime() - 90 * 86_400_000), retentionDays: 90, batchSize: 100, budget: 1000 });
    expect(outcome.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.supportReport.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.supportReportFile.findUnique({ where: { id: old.files[0].id } })).toBeNull();
    expect(await prisma.supportReport.findUnique({ where: { id: openId } })).not.toBeNull();
    void admin;
  } finally {
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
    await userCtx.close().catch(() => {});
    await adminCtx.close().catch(() => {});
  }
});
