import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A real 240×160 PNG: the upload API sniffs the leading bytes, and unlike the
// 1×1 placeholder other specs use, this one has a size the zoom assertions and
// the click targets can work with.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAABRElEQVR42u3SQQ0AAAjEsBOGJnQiCxV8SJMqWJbqgTciAYYGQ4OhwdAYGgwNhgZDg6ExNBgaDA2GBkNjaDA0GBoMDYbG0GBoMDQYGgyNocHQYGgwNBgaQ4OhwdBgaDA0hgZDg6HB0BgaDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0GBpDg6HB0GBoMDSGBkODocHQYGgMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6ExtAoYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkNjaDA0GBoMDYbG0GBoMDTcWD9W2Km79AX5AAAAAElFTkSuQmCC',
  'base64'
);

// The bug this guards: an enlarged image used to open in a new tab, which
// inside the installed app has no chrome — no back, no close — so the only way
// out was killing the app (reported 2026-09-02).
test('an enlarged image can always be closed again', async ({ page }) => {
  const adminEmail = uniqueEmail('lightbox-admin');
  const menteeEmail = uniqueEmail('lightbox-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Lightbox Admin');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Lightbox Mentee');
  const uniqueText = `Lightbox announcement ${Date.now().toString(36)}`;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/announcements', {
      multipart: {
        text: uniqueText,
        image: { name: 'poster.png', mimeType: 'image/png', buffer: PNG },
      },
    });
    expect(res.status(), await res.text()).toBe(201);

    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto('/announcements');
    const thumb = page.getByTestId('announcement-image').first();
    await expect(thumb).toBeVisible({ timeout: 10_000 });

    const lightbox = page.getByTestId('image-lightbox');

    // 1. The ✕ button — the exit the report asked for.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    // No new tab: the viewer is in this page.
    expect(page.context().pages()).toHaveLength(1);
    await page.getByTestId('image-lightbox-close').click();
    await expect(lightbox).toHaveCount(0);

    // 2. Escape.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);

    // 3. A tap on the surround — but not on the image itself, which zooms.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await page.getByTestId('image-lightbox-image').click();
    await expect(lightbox).toBeVisible();
    await page.getByTestId('image-lightbox-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(lightbox).toHaveCount(0);

    // 4. The phone's back button: it closes the viewer and stays on the page.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await page.goBack();
    await expect(lightbox).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/announcements');
    await expect(thumb).toBeVisible();

    // Closing the viewer must not leave the pushed history entry behind:
    // one back from here leaves /announcements, it does not reopen the image.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await page.getByTestId('image-lightbox-close').click();
    await expect(lightbox).toHaveCount(0);
    await page.goBack();
    await expect(lightbox).toHaveCount(0);
    expect(new URL(page.url()).pathname).not.toBe('/announcements');
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('the viewer walks between several images and zooms', async ({ page }) => {
  const menteeEmail = uniqueEmail('lightbox-gallery');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Lightbox Gallery Mentee');

  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto('/messages/support');
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    // Two attached-but-unsent images are the cheapest two-image gallery in the
    // app, and they exercise the same viewer as a sent attachment.
    await page.getByTestId('support-file-input').setInputFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: PNG },
      { name: 'second.png', mimeType: 'image/png', buffer: PNG },
    ]);
    const thumbs = page.getByTestId('pending-attachments').getByTestId('pending-image-attachment');
    await expect(thumbs).toHaveCount(2);

    await thumbs.first().click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2');

    await page.getByTestId('image-lightbox-next').click();
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('2 / 2');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2');

    // Zoom is a real size change, and it resets when moving to the next image.
    const image = page.getByTestId('image-lightbox-image');
    const fitted = await image.boundingBox();
    await page.getByTestId('image-lightbox-zoom-in').click();
    await expect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeGreaterThan(fitted!.width);
    await page.getByTestId('image-lightbox-next').click();
    await expect
      .poll(async () => (await image.boundingBox())!.width)
      .toBe(fitted!.width);

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
