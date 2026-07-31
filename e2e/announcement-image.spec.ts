import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A real 1×1 PNG: the API sniffs the leading bytes, so a placeholder buffer
// would be rejected as 'unreadable' rather than exercising the happy path.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

test('an admin can attach an image to a broadcast and every reader sees it', async ({ page }) => {
  const adminEmail = uniqueEmail('annimg-admin');
  const menteeEmail = uniqueEmail('annimg-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Image Admin');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Image Mentee');
  const uniqueText = `Image announcement ${Date.now().toString(36)}`;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await page.goto('/admin/announcements');

    await page.getByTestId('announcement-text').fill(uniqueText);
    await page.getByTestId('announcement-image-input').setInputFiles({
      name: 'poster.png',
      mimeType: 'image/png',
      buffer: PNG_1X1,
    });
    // Local preview appears without a round-trip (object URL).
    await expect(page.getByTestId('announcement-image-preview')).toBeVisible();

    const postDone = page.waitForResponse(
      (r) => r.url().includes('/api/admin/announcements') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /^Broadcast$/i }).click();
    const response = await postDone;
    expect(response.status(), await response.text()).toBe(201);

    const record = await prisma.announcement.findFirst({
      where: { text: uniqueText },
      include: { image: { select: { contentType: true, size: true } } },
    });
    expect(record?.image?.contentType).toBe('image/png');
    expect(record?.image?.size).toBe(PNG_1X1.length);

    // The blob is served back as an image, and only as an image.
    const imageRes = await page.request.get(`/api/announcements/${record!.id}/image`);
    expect(imageRes.status()).toBe(200);
    expect(imageRes.headers()['content-type']).toBe('image/png');
    expect(imageRes.headers()['x-content-type-options']).toBe('nosniff');
    expect((await imageRes.body()).length).toBe(PNG_1X1.length);

    // A reader (not the sender) sees the image on the shared feed.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto('/announcements');
    await expect(page.getByTestId('announcements-full-list').getByText(uniqueText)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('announcement-image').first()).toHaveAttribute(
      'src',
      `/api/announcements/${record!.id}/image`
    );
  } finally {
    // AnnouncementImage is cascade-deleted with its announcement.
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('the image endpoint is not readable without a session', async ({ page, browser }) => {
  const adminEmail = uniqueEmail('annimg-auth');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Image Auth Admin');
  const uniqueText = `Auth image announcement ${Date.now().toString(36)}`;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/announcements', {
      multipart: {
        text: uniqueText,
        image: { name: 'poster.png', mimeType: 'image/png', buffer: PNG_1X1 },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const record = await prisma.announcement.findFirst({ where: { text: uniqueText } });

    // A brand-new context carries no session cookie.
    const anon = await browser.newContext();
    const anonRes = await anon.request.get(`/api/announcements/${record!.id}/image`);
    expect(anonRes.status()).toBe(401);
    await anon.close();
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
  }
});

test('a non-image file is refused before the broadcast is sent', async ({ page }) => {
  const adminEmail = uniqueEmail('annimg-reject');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Image Reject Admin');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await page.goto('/admin/announcements');

    // setInputFiles bypasses the `accept` filter, which is exactly the case the
    // client-side validation exists for.
    await page.getByTestId('announcement-image-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('definitely not an image'),
    });

    await expect(page.getByText('Only PNG, JPEG, WebP or GIF images are allowed.')).toBeVisible();
    await expect(page.getByTestId('announcement-image-preview')).toHaveCount(0);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('the API rejects a file that only claims to be an image', async ({ page }) => {
  const adminEmail = uniqueEmail('annimg-sniff');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Image Sniff Admin');
  const uniqueText = `Sniffed image announcement ${Date.now().toString(36)}`;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/announcements', {
      multipart: {
        text: uniqueText,
        // Declares image/png; the bytes are HTML. Serving this back under an
        // image content type is the stored-XSS shape the sniff check blocks.
        image: {
          name: 'payload.png',
          mimeType: 'image/png',
          buffer: Buffer.from('<html><script>alert(1)</script></html>'),
        },
      },
    });
    expect(res.status()).toBe(400);

    // Rejected *before* the fan-out: no announcement, no notifications.
    expect(await prisma.announcement.findFirst({ where: { text: uniqueText } })).toBeNull();
    expect(await prisma.notification.count({ where: { text: uniqueText } })).toBe(0);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
  }
});
