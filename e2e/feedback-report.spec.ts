import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3130: the floating feedback button. A signed-in person opens it (the
// screenshot is taken on open), describes the problem and sends; the report
// lands with the masked console + network context; only an ADMIN reads it in
// /admin/support/reports and moves its status. A security boundary (a picture
// of someone's screen), so it is in the smoke set.
test('feedback widget: send with screenshot + masked context, admin triages it', { tag: '@smoke' }, async ({ browser }) => {
  // Two sign-ins, a DOM capture and three admin pages: past 60s on a cold
  // `next dev`, well inside it on CI's `next start`.
  test.slow();
  const userEmail = uniqueEmail('fb-user');
  const adminEmail = uniqueEmail('fb-admin');
  const pw = 'FeedbackReport123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'Feedback User');
  await seedUser(adminEmail, pw, 'ADMIN', 'Feedback Admin');
  const userCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    const page = await userCtx.newPage();
    await signInAndSettle(page, userEmail, pw, '/portal');

    // The widget is hydrated (and its collector installed) once its button shows.
    await expect(page.getByTestId('feedback-open')).toBeVisible({ timeout: 15_000 });
    // Something goes wrong on the page: a failed request carrying a secret in
    // its query, and a console error carrying a password.
    await page.evaluate(async () => {
      await fetch('/api/feedback-e2e-missing?token=SECRET-QUERY-VALUE').catch(() => null);
      console.error('save failed password=hunter2-e2e');
    });

    await page.getByTestId('feedback-open').click();
    const panel = page.getByTestId('feedback-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('feedback-screenshot')).toBeVisible({ timeout: 15_000 });

    // Both required answers are enforced before anything is sent.
    await panel.getByTestId('feedback-send').click();
    await expect(panel.getByRole('alert')).toBeVisible();

    await panel.getByTestId('feedback-description').fill('The save button does nothing on my profile.');
    await panel.getByTestId('feedback-contact-true').check();
    const sent = page.waitForResponse((r) => r.url().includes('/api/support/reports') && r.request().method() === 'POST');
    await panel.getByTestId('feedback-send').click();
    expect((await sent).status()).toBe(201);
    await expect(panel).toBeHidden();

    const report = await prisma.supportReport.findFirstOrThrow({
      where: { userId: user.id },
      include: { files: { select: { kind: true, contentType: true, size: true } } },
    });
    expect(report.type).toBe('BUG');
    expect(report.contactAllowed).toBe(true);
    expect(report.status).toBe('NEW');
    // One screenshot; the e2e server also has session replay on (#3131), whose
    // file is pinned by feedback-replay.spec.ts.
    expect(report.files.filter((f) => f.kind === 'SCREENSHOT')).toEqual([expect.objectContaining({ contentType: 'image/jpeg' })]);
    const stored = JSON.stringify(report.context);
    expect(stored).toContain('/api/feedback-e2e-missing?token=***');
    expect(stored).toContain('save failed password=***');
    expect(stored).not.toContain('SECRET-QUERY-VALUE');
    expect(stored).not.toContain('hunter2-e2e');

    // The reporter is not an admin: the inbox and the record are closed to them.
    expect((await page.request.get('/api/admin/support/reports')).status()).toBe(401);
    expect((await page.request.get(`/api/admin/support/reports/${report.id}`)).status()).toBe(401);
    expect((await page.request.patch(`/api/admin/support/reports/${report.id}`, { data: { status: 'RESOLVED' } })).status()).toBe(401);
    // And an anonymous caller cannot file one.
    const anon = await browser.newContext();
    expect((await anon.request.post('/api/support/reports', { multipart: { type: 'BUG', description: 'x', contactAllowed: 'false' } })).status()).toBe(401);
    await anon.close();

    // The admin finds it in the inbox, reads the context and resolves it.
    const adminPage = await adminCtx.newPage();
    await signInAndSettle(adminPage, adminEmail, pw, '/admin');
    await gotoSettled(adminPage, '/admin/support/reports');
    await adminPage.getByTestId(`report-row-${report.id}`).click();
    const detail = adminPage.getByTestId('report-detail');
    await expect(detail.getByTestId('report-description')).toHaveText('The save button does nothing on my profile.');
    await expect(detail.getByTestId('report-screenshot')).toBeVisible();
    await expect(detail.getByTestId('report-console')).toContainText('password=***');
    await detail.getByTestId('report-tab-network').click();
    await expect(detail.getByTestId('report-network')).toContainText('/api/feedback-e2e-missing?token=***');
    await detail.getByTestId('report-status-select').selectOption('RESOLVED');
    await detail.getByTestId('report-status-save').click();
    await expect
      .poll(async () => (await prisma.supportReport.findUnique({ where: { id: report.id } }))?.status, { timeout: 10_000 })
      .toBe('RESOLVED');
  } finally {
    // Cleanup first: a context torn down by a timeout throws on close(), and
    // that must not leave the seeded accounts (and their report) behind.
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
    await userCtx.close().catch(() => {});
    await adminCtx.close().catch(() => {});
  }
});
