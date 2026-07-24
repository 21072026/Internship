import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A 1×1 transparent PNG — no fixture file needed.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// Minimal valid PDF (starts with %PDF-).
const PDF_BYTES = Buffer.from('%PDF-1.4 1 0 obj<</Type/Catalog>>endobj');

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  pw: string,
  home: string,
) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

/** Delete all support data seeded for a user and then remove the user record. */
async function cleanupSupportData(userId: string, email: string) {
  const msgs = await prisma.supportMessage.findMany({
    where: { ticket: { requesterId: userId } },
    select: { id: true },
  });
  await prisma.supportAttachment.deleteMany({ where: { messageId: { in: msgs.map((m) => m.id) } } });
  await prisma.supportMessage.deleteMany({ where: { ticket: { requesterId: userId } } });
  await prisma.supportTicket.deleteMany({ where: { requesterId: userId } });
  await cleanupByEmail(email);
}

// UI: attach an image, see the preview chip, send, and verify it renders in the thread.
test('support attachments: image preview in composer, send, renders inline in thread', async ({ page }) => {
  const email = uniqueEmail('sa-img');
  const user = await seedUser(email, 'AttPass123', 'MENTEE', 'SA Image User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');
    await page.goto('/messages/support');
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    // Attach a PNG via the hidden file input.
    await page.getByTestId('support-file-input').setInputFiles({
      name: 'screenshot.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });

    // The pending attachment thumbnail should appear.
    await expect(page.locator('img[alt="screenshot.png"]')).toBeVisible({ timeout: 5_000 });

    // Send button should be enabled (file present, text optional).
    await expect(page.getByTestId('support-send')).toBeEnabled();

    // Send and wait for the POST response.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/support') && r.request().method() === 'POST',
    );
    await page.getByTestId('support-send').click();
    const res = await done;
    expect(res.status()).toBe(201);

    // The attachment is visible in the thread after the reload.
    await expect(page.locator('a[href*="/api/support/attachments/"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('screenshot.png', { exact: false })).toBeVisible();
  } finally {
    await cleanupSupportData(user.id, email);
  }
});

// UI: file-only submission — send button is enabled even with an empty textarea.
test('support attachments: file-only message allowed (text not required)', async ({ page }) => {
  const email = uniqueEmail('sa-notext');
  const user = await seedUser(email, 'AttPass123', 'MENTEE', 'SA NoText User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');
    await page.goto('/messages/support');
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    // Textarea is empty — send must be disabled.
    await expect(page.getByTestId('support-send')).toBeDisabled();

    // Attach a PDF — send must now be enabled.
    await page.getByTestId('support-file-input').setInputFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: PDF_BYTES,
    });
    await expect(page.getByTestId('support-send')).toBeEnabled();

    // Leave the textarea blank and submit.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/support') && r.request().method() === 'POST',
    );
    await page.getByTestId('support-send').click();
    expect((await done).status()).toBe(201);

    // Attachment link visible in thread.
    await expect(page.locator('a[href*="/api/support/attachments/"]')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupSupportData(user.id, email);
  }
});

// UI: removing a pending attachment before sending.
test('support attachments: removing a pending attachment', async ({ page }) => {
  const email = uniqueEmail('sa-rm');
  await seedUser(email, 'AttPass123', 'MENTEE', 'SA Remove User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');
    await page.goto('/messages/support');
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('support-file-input').setInputFiles({
      name: 'screenshot.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });
    await expect(page.locator('img[alt="screenshot.png"]')).toBeVisible({ timeout: 5_000 });

    // Remove the file using the ×-button.
    await page.locator('button[aria-label*="screenshot.png"]').click();

    // Thumbnail gone; send button back to disabled (no text, no files).
    await expect(page.locator('img[alt="screenshot.png"]')).not.toBeVisible();
    await expect(page.getByTestId('support-send')).toBeDisabled();
  } finally {
    await cleanupByEmail(email);
  }
});

// UI: unsupported file type shows a client-side error.
test('support attachments: unsupported file type shows error', async ({ page }) => {
  const email = uniqueEmail('sa-bad');
  await seedUser(email, 'AttPass123', 'MENTEE', 'SA Bad User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');
    await page.goto('/messages/support');
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('support-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });

    // An error message should appear; the send button stays disabled.
    await expect(page.locator('p.text-red-600, [role="alert"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('support-send')).toBeDisabled();
  } finally {
    await cleanupByEmail(email);
  }
});

// Access control: requester can download, admin can too, a third party gets 403.
test('support attachments: download access control', async ({ browser }) => {
  const userEmail = uniqueEmail('sa-ac-user');
  const adminEmail = uniqueEmail('sa-ac-admin');
  const outsiderEmail = uniqueEmail('sa-ac-out');
  const pw = 'AttAccess123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'SA AC User');
  await seedUser(adminEmail, pw, 'ADMIN', 'SA AC Admin');
  await seedUser(outsiderEmail, pw, 'MENTEE', 'SA AC Outsider');

  // Seed a ticket + message + attachment directly via Prisma.
  const ticket = await prisma.supportTicket.create({ data: { requesterId: user.id, subject: 'AC test' } });
  const msg = await prisma.supportMessage.create({
    data: { ticketId: ticket.id, senderId: user.id, body: 'please help' },
  });
  const attachment = await prisma.supportAttachment.create({
    data: {
      messageId: msg.id,
      filename: 'evidence.png',
      contentType: 'image/png',
      size: PNG_BYTES.length,
      data: PNG_BYTES,
    },
  });

  const userCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const outsiderCtx = await browser.newContext();
  try {
    const userPage = await userCtx.newPage();
    await signIn(userPage, userEmail, pw, '/portal');
    const userRes = await userPage.request.get(`/api/support/attachments/${attachment.id}`);
    expect(userRes.status()).toBe(200);
    expect(userRes.headers()['content-type']).toContain('image/png');

    const adminPage = await adminCtx.newPage();
    await signIn(adminPage, adminEmail, pw, '/admin');
    const adminRes = await adminPage.request.get(`/api/support/attachments/${attachment.id}`);
    expect(adminRes.status()).toBe(200);
    expect(adminRes.headers()['content-type']).toContain('image/png');

    const outsiderPage = await outsiderCtx.newPage();
    await signIn(outsiderPage, outsiderEmail, pw, '/portal');
    const outsiderRes = await outsiderPage.request.get(`/api/support/attachments/${attachment.id}`);
    expect(outsiderRes.status()).toBe(403);

    // Unauthenticated access also rejected.
    const anonCtx = await browser.newContext();
    const anonPage = await anonCtx.newPage();
    const anonRes = await anonPage.request.get(`/api/support/attachments/${attachment.id}`);
    expect(anonRes.status()).toBe(401);
    await anonCtx.close();
  } finally {
    await userCtx.close();
    await adminCtx.close();
    await outsiderCtx.close();
    await prisma.supportAttachment.deleteMany({ where: { messageId: msg.id } });
    await prisma.supportMessage.deleteMany({ where: { ticketId: ticket.id } });
    await prisma.supportTicket.deleteMany({ where: { id: ticket.id } });
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(outsiderEmail);
  }
});

// API: empty body and no files returns 400.
test('support attachments API: empty submission rejected', async ({ page }) => {
  const email = uniqueEmail('sa-empty');
  const user = await seedUser(email, 'AttPass123', 'MENTEE', 'SA Empty User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');
    const empty = await page.request.post('/api/support', {
      multipart: { body: '   ' },
    });
    expect(empty.status()).toBe(400);
  } finally {
    await cleanupByEmail(email);
    await prisma.supportTicket.deleteMany({ where: { requesterId: user.id } });
  }
});

// API: text-only and multipart attachment-only both succeed.
test('support attachments API: text-only and attachment-only both accepted', async ({ page }) => {
  const email = uniqueEmail('sa-api');
  const user = await seedUser(email, 'AttPass123', 'MENTEE', 'SA API User');
  try {
    await signIn(page, email, 'AttPass123', '/portal');

    // Text only via JSON.
    const textOnly = await page.request.post('/api/support', { data: { body: 'Hello support.' } });
    expect(textOnly.status()).toBe(201);
    const { ticketId } = await textOnly.json();

    // Attachment only via multipart (no body text).
    const attachOnly = await page.request.post('/api/support', {
      multipart: {
        body: '',
        files: {
          name: 'screenshot.png',
          mimeType: 'image/png',
          buffer: PNG_BYTES,
        },
      },
    });
    expect(attachOnly.status()).toBe(201);
    const { ticketId: ticketId2 } = await attachOnly.json();
    // Both messages land on the same open ticket.
    expect(ticketId2).toBe(ticketId);

    // Verify the attachment was persisted.
    const stored = await prisma.supportAttachment.findFirst({
      where: { message: { ticketId } },
    });
    expect(stored).not.toBeNull();
    expect(stored!.filename).toBe('screenshot.png');
  } finally {
    await cleanupSupportData(user.id, email);
  }
});
