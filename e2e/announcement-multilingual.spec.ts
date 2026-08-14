import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1163: an announcement used to be a single body sent to everyone, even though
// every user has a preferredLanguage and the app speaks EN/TR/DE. It is now one
// message written in up to three languages, resolved per reader — in the feed,
// in the archive, and in the notification each person is handed.
test('each reader gets the announcement in their own language', async ({ page }) => {
  const adminEmail = uniqueEmail('annml-admin');
  const trEmail = uniqueEmail('annml-tr');
  const deEmail = uniqueEmail('annml-de');
  const stamp = Date.now().toString(36);
  const bodies = {
    en: `English body ${stamp}`,
    tr: `Türkçe gövde ${stamp}`,
    de: `Deutscher Text ${stamp}`,
  };
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann ML Admin');
  const trUser = await seedUser(trEmail, 'MenteePass123', 'MENTEE', 'Ann ML Turkish');
  const deUser = await seedUser(deEmail, 'MenteePass123', 'MENTEE', 'Ann ML German');
  await prisma.user.update({ where: { id: trUser.id }, data: { preferredLanguage: 'tr' } });
  await prisma.user.update({ where: { id: deUser.id }, data: { preferredLanguage: 'de' } });

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const posted = await page.request.post('/api/admin/announcements', {
      data: { translations: bodies },
    });
    expect(posted.ok()).toBeTruthy();

    // The canonical column holds the default locale's wording, so anything that
    // reads `text` directly keeps working.
    const record = await prisma.announcement.findFirstOrThrow({ where: { text: bodies.en } });
    expect(record.translations).toMatchObject(bodies);

    // The bell row each person was handed is already in their language — a
    // notification is per-user, so it is resolved once at fan-out.
    const trNote = await prisma.notification.findFirst({
      where: { userId: trUser.id, announcementId: record.id },
    });
    expect(trNote?.text).toBe(bodies.tr);
    const deNote = await prisma.notification.findFirst({
      where: { userId: deUser.id, announcementId: record.id },
    });
    expect(deNote?.text).toBe(bodies.de);

    // And the feed follows the reader, not the sender.
    await signInAsFreshUser(page, trEmail, 'MenteePass123', '/portal');
    const trFeed = await (await page.request.get('/api/announcements?page=1&pageSize=10')).json();
    const trItem = trFeed.announcements.find((a: { id: string }) => a.id === record.id);
    expect(trItem.text).toBe(bodies.tr);
    expect(trItem.languageFallback).toBe(false);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: bodies.en } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(trEmail);
    await cleanupByEmail(deEmail);
  }
});

// A language that was never written must not leave the reader with a blank
// screen — they get what was written, and are told that is what happened.
test('a reader whose language was not written gets a marked fallback', async ({ page }) => {
  const adminEmail = uniqueEmail('annfb-admin');
  const deEmail = uniqueEmail('annfb-de');
  const stamp = Date.now().toString(36);
  const bodies = { en: `Only English ${stamp}`, tr: `Sadece Türkçe ${stamp}` };
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann FB Admin');
  const deUser = await seedUser(deEmail, 'MenteePass123', 'MENTEE', 'Ann FB German');
  await prisma.user.update({ where: { id: deUser.id }, data: { preferredLanguage: 'de' } });

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    expect((await page.request.post('/api/admin/announcements', { data: { translations: bodies } })).ok()).toBeTruthy();
    const record = await prisma.announcement.findFirstOrThrow({ where: { text: bodies.en } });

    await signInAsFreshUser(page, deEmail, 'MenteePass123', '/portal');
    const feed = await (await page.request.get('/api/announcements?page=1&pageSize=10')).json();
    const item = feed.announcements.find((a: { id: string }) => a.id === record.id);
    // No German version: falls back to the default locale, and says so.
    expect(item.text).toBe(bodies.en);
    expect(item.languageFallback).toBe(true);

    await page.goto('/announcements');
    await expect(page.getByTestId('announcement-language-fallback').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.announcement.deleteMany({ where: { text: bodies.en } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(deEmail);
  }
});

// A single-language announcement is still a valid announcement — the composer's
// language tabs must not turn "write one message" into "write three".
test('one language is enough, and the admin form sends what was typed', async ({ page }) => {
  const adminEmail = uniqueEmail('annone-admin');
  const text = `Single language ${Date.now().toString(36)}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann One Admin');

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    await page.goto('/admin/announcements');

    // Type into the Turkish tab only.
    await page.getByTestId('announcement-tab-tr').click();
    await page.getByTestId('announcement-text').fill(text);
    // The tab now marks itself as written; the others do not.
    await expect(page.getByTestId('announcement-tab-tr')).toHaveAttribute('data-filled', 'true');
    await expect(page.getByTestId('announcement-tab-de')).toHaveAttribute('data-filled', 'false');

    const postDone = page.waitForResponse(
      (r) => r.url().includes('/api/admin/announcements') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /^Broadcast$/i }).click();
    await postDone;

    const record = await prisma.announcement.findFirstOrThrow({ where: { text } });
    // Nothing in English, so the Turkish body becomes the canonical wording.
    expect(record.text).toBe(text);
    expect(record.translations).toMatchObject({ tr: text });
  } finally {
    await prisma.announcement.deleteMany({ where: { text } });
    await cleanupByEmail(adminEmail);
  }
});

// Editing keeps every language it had: correcting the German must not flatten
// the Turkish reader back to English.
test('editing a multilingual announcement re-resolves every reader’s notification', async ({ page }) => {
  const adminEmail = uniqueEmail('annmledit-admin');
  const trEmail = uniqueEmail('annmledit-tr');
  const stamp = Date.now().toString(36);
  const before = { en: `EN before ${stamp}`, tr: `TR before ${stamp}` };
  const after = { en: `EN after ${stamp}`, tr: `TR after ${stamp}` };
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann MLEdit Admin');
  const trUser = await seedUser(trEmail, 'MenteePass123', 'MENTEE', 'Ann MLEdit Turkish');
  await prisma.user.update({ where: { id: trUser.id }, data: { preferredLanguage: 'tr' } });

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    expect((await page.request.post('/api/admin/announcements', { data: { translations: before } })).ok()).toBeTruthy();
    const record = await prisma.announcement.findFirstOrThrow({ where: { text: before.en } });
    expect(
      (await prisma.notification.findFirst({ where: { userId: trUser.id, announcementId: record.id } }))?.text
    ).toBe(before.tr);

    const patched = await page.request.patch(`/api/admin/announcements/${record.id}`, {
      data: { translations: after },
    });
    expect(patched.ok()).toBeTruthy();

    // The Turkish reader's bell row followed the Turkish edit — not the
    // canonical English one.
    expect(
      (await prisma.notification.findFirst({ where: { userId: trUser.id, announcementId: record.id } }))?.text
    ).toBe(after.tr);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: { in: [before.en, after.en] } } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(trEmail);
  }
});
