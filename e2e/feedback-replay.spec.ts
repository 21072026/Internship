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
    // The person can watch what would be sent before sending it.
    await panel.getByTestId('feedback-replay-preview').click();
    await expect(panel.getByTestId('feedback-replay-player').locator('.rr-player')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('feedback-replay-meta')).toBeVisible();
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

// The person starts and stops a recording themselves (#3131 follow-up): the
// panel gets out of the way while it runs, nothing is sent until Send, and
// what is attached begins where they pressed Start.
test('feedback replay: a recording the person starts and stops, previewed before Send', { tag: '@smoke' }, async ({ browser }) => {
  test.slow();
  const userEmail = uniqueEmail('fbm-user');
  const pw = 'FeedbackManual123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'Manual User');
  const ctx = await browser.newContext();
  const marker = `MANUAL-MARKER-${Date.now()}`;
  try {
    const page = await ctx.newPage();
    await signInAndSettle(page, userEmail, pw, '/portal');
    await expect(page.getByTestId('feedback-open')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('feedback-open').click();
    const panel = page.getByTestId('feedback-panel');
    await panel.getByTestId('feedback-description').fill('It breaks after the second click.');
    const startedAt = Date.now();
    await panel.getByTestId('feedback-record-start').click();

    // While recording: no panel, a Stop pill, and nothing goes out.
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('feedback-open')).toBeHidden();
    const pill = page.getByTestId('feedback-recording');
    await expect(pill).toBeVisible();
    const sent: string[] = [];
    page.on('request', (r) => sent.push(`${r.url()} ${r.postDataBuffer()?.toString('latin1') ?? ''}`));
    await page.evaluate((text) => {
      const box = document.createElement('div');
      box.textContent = text;
      (document.querySelector('main') ?? document.body).prepend(box);
    }, marker);
    await expect(pill).toContainText(/0:0[2-9]/, { timeout: 10_000 });
    for (const r of sent) {
      expect(r).not.toContain('/api/support/reports');
      expect(r).not.toContain(marker);
    }

    // Stop: back to the report, the description kept, the recording attached.
    await page.getByTestId('feedback-record-stop').click();
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(pill).toBeHidden();
    await expect(panel.getByTestId('feedback-description')).toHaveValue('It breaks after the second click.');
    await expect(panel.getByTestId('feedback-replay')).toBeChecked();
    await expect(panel.getByTestId('feedback-replay-meta')).toContainText(/0:0\d · [\d.,]+ KB/);
    await expect(panel.getByTestId('feedback-replay-discard')).toBeVisible();
    await panel.getByTestId('feedback-replay-preview').click();
    await expect(panel.getByTestId('feedback-replay-player').locator('.rr-player')).toBeVisible({ timeout: 20_000 });

    await panel.getByTestId('feedback-contact-false').check();
    const posted = page.waitForResponse((r) => r.url().includes('/api/support/reports') && r.request().method() === 'POST');
    await panel.getByTestId('feedback-send').click();
    expect((await posted).status()).toBe(201);

    const report = await prisma.supportReport.findFirstOrThrow({ where: { userId: user.id }, include: { files: true } });
    const replay = report.files.find((f) => f.kind === 'REPLAY');
    const events = JSON.parse(gunzipSync(Buffer.from(replay!.data)).toString('utf8')) as { type: number; timestamp: number }[];
    expect(JSON.stringify(events)).toContain(marker);
    // It starts at Start, on a full snapshot — not on the rolling window before it.
    expect(events[0].timestamp).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(events.some((e) => e.type === 2)).toBe(true);
  } finally {
    await cleanupByEmail(userEmail);
    await ctx.close().catch(() => {});
  }
});
