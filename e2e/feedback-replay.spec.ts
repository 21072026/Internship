import { gunzipSync } from 'node:zlib';
import { test, expect, type Request } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3131: the session replay attached to a bug report. Three promises are
// pinned here: nothing of the recording leaves the browser before Send; what
// a person typed never reaches the recording; and an admin can play it back.
// A privacy boundary, so it is in the smoke set.
test('feedback replay: in memory until Send, typed values masked, admin plays it', { tag: '@smoke' }, async ({ browser }) => {
  test.slow();
  const userEmail = uniqueEmail('fbr-user');
  const adminEmail = uniqueEmail('fbr-admin');
  const pw = 'FeedbackReplay123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'Replay User');
  await seedUser(adminEmail, pw, 'ADMIN', 'Replay Admin');
  const userCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const marker = `REPLAY-MARKER-${Date.now()}`;
  const typed = `SECRET-TYPED-${Date.now()}`;
  try {
    const page = await userCtx.newPage();
    await signInAndSettle(page, userEmail, pw, '/portal');
    await expect(page.getByTestId('feedback-open')).toBeVisible({ timeout: 15_000 });

    const sent: { url: string; body: Buffer | null }[] = [];
    const onRequest = (r: Request) => sent.push({ url: r.url(), body: r.postDataBuffer() });
    page.on('request', onRequest);

    // Something to record: visible text, and a value typed into a field.
    await page.evaluate((text) => {
      const box = document.createElement('div');
      box.textContent = text;
      const input = document.createElement('input');
      input.setAttribute('data-testid', 'replay-e2e-input');
      box.appendChild(input);
      document.querySelector('main')?.prepend(box) ?? document.body.prepend(box);
    }, marker);
    await page.getByTestId('replay-e2e-input').fill(typed);
    await page.waitForTimeout(1500);

    // Before Send: the recording has not left the tab, in any request.
    for (const r of sent) {
      expect(r.url).not.toContain('/api/support/reports');
      const body = r.body?.toString('latin1') ?? '';
      expect(body).not.toContain(marker);
      expect(body).not.toContain(typed);
    }

    await page.getByTestId('feedback-open').click();
    const panel = page.getByTestId('feedback-panel');
    await expect(panel.getByTestId('feedback-replay')).toBeChecked({ timeout: 15_000 });
    await panel.getByTestId('feedback-description').fill('The page froze after I typed.');
    await panel.getByTestId('feedback-contact-false').check();
    const posted = page.waitForResponse((r) => r.url().includes('/api/support/reports') && r.request().method() === 'POST');
    await panel.getByTestId('feedback-send').click();
    expect((await posted).status()).toBe(201);
    page.off('request', onRequest);

    const report = await prisma.supportReport.findFirstOrThrow({
      where: { userId: user.id },
      include: { files: true },
    });
    const replay = report.files.find((f) => f.kind === 'REPLAY');
    expect(replay?.contentType).toBe('application/gzip');
    const json = gunzipSync(Buffer.from(replay!.data)).toString('utf8');
    expect(json).toContain(marker);
    expect(json).not.toContain(typed);
    expect(report.files.find((f) => f.kind === 'SCREENSHOT')).toBeTruthy();

    // The server refuses anything that is not a gzip of rrweb events.
    const junk = await page.request.post('/api/support/reports', {
      multipart: {
        type: 'BUG', description: 'junk replay', contactAllowed: 'false',
        replay: { name: 'replay.json.gz', mimeType: 'application/gzip', buffer: Buffer.from('{"not":"gzip"}') },
      },
    });
    const junkBody = await junk.text();
    expect(junk.status(), junkBody).toBe(400);
    expect(JSON.parse(junkBody).code, junkBody).toBe('replay_invalid');

    // The admin plays it back.
    const adminPage = await adminCtx.newPage();
    await signInAndSettle(adminPage, adminEmail, pw, '/admin');
    await gotoSettled(adminPage, `/admin/support/reports/${report.id}`);
    const player = adminPage.getByTestId('report-replay');
    await expect(player.locator('.rr-player')).toBeVisible({ timeout: 20_000 });
    await expect(player.locator('.rr-timeline')).toBeVisible();
  } finally {
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
    await userCtx.close().catch(() => {});
    await adminCtx.close().catch(() => {});
  }
});
