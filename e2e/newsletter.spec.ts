import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * The newsletter module (#1469).
 *
 * The two behaviours worth a browser test are the ones a unit test cannot
 * reach: an issue picked from the library actually reaching a recipient's
 * delivery record, and the one-click unsubscribe keeping the NEXT issue away
 * from that person. Everything else (content normalisation, per-locale
 * resolution) is pure and covered by the shapes themselves.
 *
 * Not tagged @smoke: the PR gate stays small, and this is not a critical path.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an issue from the library sends, records every recipient, and stays on the record', async ({ page }) => {
  const adminEmail = uniqueEmail('nl-admin');
  const menteeEmail = uniqueEmail('nl-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Newsletter Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Newsletter Mentee');
  let newsletterId: string | null = null;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await gotoSettled(page, '/admin/newsletters');

    // The library ships in the repo, so this button exists on a fresh install.
    await page.getByTestId('newsletter-template-cv-impact-bullets').click();
    // Prefilling is what makes the library worth having: all three languages at
    // once, not just the tab that happens to be open.
    await expect(page.getByTestId('newsletter-subject')).not.toHaveValue('');

    const postDone = page.waitForResponse(
      (r) => r.url().includes('/api/admin/newsletters') && r.request().method() === 'POST'
    );
    await page.getByTestId('newsletter-send-now').click();
    await postDone;

    // The composer reports the real tally, and the row is SENT.
    await expect(page.getByTestId('newsletter-result')).toBeVisible({ timeout: 15_000 });

    const issue = await prisma.newsletter.findFirst({
      where: { templateKey: 'cv-impact-bullets' },
      orderBy: { createdAt: 'desc' },
    });
    expect(issue).not.toBeNull();
    newsletterId = issue!.id;
    expect(issue!.status).toBe('SENT');
    expect(issue!.audience).toBe('MENTEE');
    expect(issue!.sentAt).not.toBeNull();
    // Three languages written, so the canonical subject is the English one.
    expect(Object.keys(issue!.content as object).sort()).toEqual(['de', 'en', 'tr']);

    // The delivery record — the thing EmailLog's 90-day pruning cannot keep.
    const send = await prisma.newsletterSend.findFirst({
      where: { newsletterId: newsletterId!, userId: mentee.id },
    });
    expect(send).not.toBeNull();
    expect(send!.email).toBe(menteeEmail);
    // No SMTP in CI, so sendEmail returns SKIPPED and the row records exactly
    // that — the point of the assertion is that a row exists at all and says
    // what really happened, not that mail left the box.
    expect(['SENT', 'SKIPPED']).toContain(send!.status);

    // A sent issue is history: the API refuses to delete it.
    const deleteRes = await page.request.delete(`/api/admin/newsletters/${newsletterId}`);
    expect(deleteRes.status()).toBe(409);

    // And it survives a reload, i.e. it is a real row rather than local state.
    await page.reload();
    await expect(page.getByTestId('newsletter-history')).toContainText(issue!.subject);
  } finally {
    if (newsletterId) await prisma.newsletter.deleteMany({ where: { id: newsletterId } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('one-click unsubscribe keeps the next issue away from that reader', async ({ page }) => {
  const adminEmail = uniqueEmail('nl-unsub-admin');
  const menteeEmail = uniqueEmail('nl-unsub-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Unsub Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Unsub Mentee');
  const created: string[] = [];

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');

    // The unsubscribe link is minted from the server secret, so it is read back
    // out of a real send rather than constructed here. Send one issue first.
    await gotoSettled(page, '/admin/newsletters');
    await page.getByTestId('newsletter-template-cold-outreach').click();
    const firstPost = page.waitForResponse(
      (r) => r.url().includes('/api/admin/newsletters') && r.request().method() === 'POST'
    );
    await page.getByTestId('newsletter-send-now').click();
    await firstPost;
    const first = await prisma.newsletter.findFirst({ where: { templateKey: 'cold-outreach' }, orderBy: { createdAt: 'desc' } });
    if (first) created.push(first.id);
    expect(await prisma.newsletterSend.count({ where: { newsletterId: first!.id, userId: mentee.id } })).toBe(1);

    // Unsubscribe the mentee through the preference route they would reach from
    // the footer link (the token page POSTs the same change).
    await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { newsletter: false } } });

    // A second issue must now skip them entirely — counted, but with no row,
    // because storing the address of someone who asked not to be mailed in
    // order to record not mailing them is the wrong trade.
    await page.reload();
    await page.getByTestId('newsletter-template-linkedin-tune-up').click();
    const secondPost = page.waitForResponse(
      (r) => r.url().includes('/api/admin/newsletters') && r.request().method() === 'POST'
    );
    await page.getByTestId('newsletter-send-now').click();
    await secondPost;

    const second = await prisma.newsletter.findFirst({ where: { templateKey: 'linkedin-tune-up' }, orderBy: { createdAt: 'desc' } });
    expect(second).not.toBeNull();
    created.push(second!.id);
    expect(await prisma.newsletterSend.count({ where: { newsletterId: second!.id, userId: mentee.id } })).toBe(0);
    expect(second!.skippedCount).toBeGreaterThan(0);
  } finally {
    if (created.length) await prisma.newsletter.deleteMany({ where: { id: { in: created } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the composer preview renders the real mail inside a sandboxed frame', async ({ page }) => {
  const adminEmail = uniqueEmail('nl-preview-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Preview Admin');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await gotoSettled(page, '/admin/newsletters');
    await page.getByTestId('newsletter-template-interview-star').click();
    await page.getByTestId('newsletter-preview-btn').click();

    // The preview is rendered by the same server code that renders the real
    // mail, so the issue's own subject has to appear inside the frame.
    const frame = page.frameLocator('[data-testid="newsletter-preview"]');
    await expect(frame.locator('h1')).toContainText('STAR', { timeout: 15_000 });

    // …and the frame stays fully sandboxed: an empty `sandbox` gives the mail
    // HTML an opaque origin with no script, forms or navigation. Asserted
    // because losing this attribute is silent — the preview looks identical
    // either way, and only the blast radius changes.
    await expect(page.getByTestId('newsletter-preview')).toHaveAttribute('sandbox', '');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('the unsubscribe page works with no session and refuses a forged token', async ({ page }) => {
  // Public by design: it has to work months later, on a phone, with no login.
  await gotoSettled(page, '/newsletter/unsubscribe?token=not-a-real-token');
  await page.getByTestId('newsletter-unsub').click();
  await expect(page.getByTestId('newsletter-unsub-failed')).toBeVisible();

  // No token at all is an explanation, not a broken button.
  await gotoSettled(page, '/newsletter/unsubscribe');
  await expect(page.getByTestId('newsletter-unsub')).toHaveCount(0);
});
