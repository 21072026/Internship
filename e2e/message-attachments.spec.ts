import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A 1x1 transparent PNG, inline — no fixture file needed.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('sending a message with an image attachment shows it inline and enforces access control', async ({ page }) => {
  const mentorEmail = uniqueEmail('att-mentor');
  const menteeEmail = uniqueEmail('att-mentee');
  const outsiderEmail = uniqueEmail('att-outsider');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Att Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Att Mentee');
  await seedUser(outsiderEmail, 'OutsiderPass123', 'MENTOR', 'Att Outsider');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    await gotoSettled(page, `/messages/${rel.id}`);
    await page.getByTestId('message-attachment-input').setInputFiles({
      name: 'screenshot.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });
    // Images render as a thumbnail in the pending list (alt=filename), not as text.
    await expect(
      page.getByTestId('pending-attachments').locator('img[alt="screenshot.png"]')
    ).toBeVisible();

    const done = page.waitForResponse((r) => r.url().includes('/api/messages') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send' }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();

    // Renders as an inline image in the thread.
    await expect(page.locator('img[alt="screenshot.png"]')).toBeVisible({ timeout: 10_000 });

    const attachment = await prisma.messageAttachment.findFirst({ where: { message: { relationId: rel.id } } });
    expect(attachment).not.toBeNull();
    expect(attachment?.size).toBe(PNG_BYTES.length);

    // An outsider (not a participant) is refused the attachment bytes.
    await page.context().clearCookies();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', outsiderEmail);
    await page.fill('input[type="password"]', 'OutsiderPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    const forbidden = await page.request.get(`/api/messages/attachments/${attachment!.id}`);
    expect(forbidden.status()).toBe(403);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(outsiderEmail);
  }
});
