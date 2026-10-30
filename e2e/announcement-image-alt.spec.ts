import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A 1x1 PNG — the upload sniffs the bytes, so it has to be a real one.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// EN 301 549 11.8.2 / Section 508 504.3 (#3388): the announcement composer asks
// for a description of an attached image; it is stored, rendered as the image's
// alt text in the reader's feed, editable afterwards, and an empty one keeps the
// image decorative (alt="").
test('an announcement image carries the description its author typed', async ({ page }) => {
  test.slow();
  const adminEmail = uniqueEmail('ann-alt-admin');
  const menteeEmail = uniqueEmail('ann-alt-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Alt Admin');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Alt Mentee');
  const nonce = Date.now().toString(36);
  const description = `Group photo of the autumn cohort ${nonce}`;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');

    // The prompt: picking an image shows the description field.
    await gotoSettled(page, '/admin/announcements');
    await page.getByTestId('announcement-image-input').setInputFiles({ name: 'cohort.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('announcement-image-alt')).toBeVisible();
    await expect(page.getByLabel('Describe this image').first()).toBeVisible();

    // Stored through the same route the form posts to.
    const res = await page.request.post('/api/admin/announcements', {
      multipart: { text: `Alt announcement ${nonce}`, image: { name: 'cohort.png', mimeType: 'image/png', buffer: PNG }, imageAlt: description },
    });
    expect(res.status(), await res.text()).toBe(201);
    const row = await prisma.announcement.findFirstOrThrow({ where: { text: `Alt announcement ${nonce}` }, include: { image: true } });
    expect(row.image?.altText).toBe(description);

    // Over the column's width is a 400, never a 500.
    const tooLong = await page.request.post('/api/admin/announcements', {
      multipart: { text: `Too long ${nonce}`, image: { name: 'x.png', mimeType: 'image/png', buffer: PNG }, imageAlt: 'a'.repeat(501) },
    });
    expect(tooLong.status()).toBe(400);

    // Editing the description alone (JSON PATCH, no new file).
    const patched = await page.request.patch(`/api/admin/announcements/${row.id}`, {
      data: { text: `Alt announcement ${nonce}`, imageAlt: `${description}, outdoors` },
    });
    expect(patched.status(), await patched.text()).toBe(200);
    expect((await patched.json()).imageAlt).toBe(`${description}, outdoors`);

    // The reader sees it as the image's alt text.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    await gotoSettled(page, '/announcements');
    await expect(page.locator(`img[alt="${description}, outdoors"]`).first()).toBeVisible({ timeout: 15_000 });

    // An empty description makes it decorative again.
    await prisma.announcementImage.update({ where: { announcementId: row.id }, data: { altText: null } });
    await page.reload();
    await expect(page.locator(`img[alt="${description}, outdoors"]`)).toHaveCount(0);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: { contains: nonce } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

// Same prompt on the newsletter's hero image (#3388): stored on create, editable
// on a draft, returned to the admin list, and empty means decorative.
test('a newsletter hero image carries its description', async ({ page }) => {
  const adminEmail = uniqueEmail('nl-alt-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Newsletter Alt Admin');
  const nonce = Date.now().toString(36);
  let id: string | null = null;
  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const content = { en: { subject: `Alt issue ${nonce}`, intro: 'Intro', tips: [{ title: 'Tip', body: 'Body' }] } };
    const res = await page.request.post('/api/admin/newsletters', {
      multipart: {
        content: JSON.stringify(content),
        audience: 'MENTEE',
        action: 'draft',
        image: { name: 'hero.png', mimeType: 'image/png', buffer: PNG },
        imageAlt: `Hero ${nonce}`,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const row = await prisma.newsletter.findFirstOrThrow({ where: { subject: `Alt issue ${nonce}` }, include: { image: true } });
    id = row.id;
    expect(row.image?.altText).toBe(`Hero ${nonce}`);

    const patched = await page.request.patch(`/api/admin/newsletters/${id}`, { data: { imageAlt: '   ' } });
    expect(patched.status(), await patched.text()).toBe(200);
    expect((await prisma.newsletterImage.findUniqueOrThrow({ where: { newsletterId: id } })).altText).toBeNull();

    const tooLong = await page.request.patch(`/api/admin/newsletters/${id}`, { data: { imageAlt: 'a'.repeat(501) } });
    expect(tooLong.status()).toBe(400);
  } finally {
    if (id) await prisma.newsletter.deleteMany({ where: { id } });
    await cleanupByEmail(adminEmail);
  }
});
