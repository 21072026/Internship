import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// WCAG 3.1.2 Language of Parts (#2864): text whose language is KNOWN and may
// differ from the interface carries its own `lang` — the language switcher
// (each language named in itself) and the per-language fields an admin fills
// (here: the goal template form, which every EN/TR/DE editor shares in shape).
test('the language switcher and per-language fields declare their language', async ({ page }) => {
  await gotoSettled(page, '/features');
  const switcher = page.getByTestId('language-switcher').first();
  for (const [code, name] of [['en', 'English'], ['tr', 'Türkçe'], ['de', 'Deutsch']] as const) {
    const button = switcher.getByRole('button', { name: `${code} ${name}`, exact: true });
    await expect(button).toHaveAttribute('lang', code);
  }

  const email = uniqueEmail('lang-parts');
  const pw = 'LangParts123';
  await seedUser(email, pw, 'ADMIN', 'Language Parts');
  try {
    await signInAndSettle(page, email, pw, '/admin');
    await gotoSettled(page, '/admin/goal-templates');
    for (const code of ['en', 'tr', 'de']) {
      await expect(page.getByTestId(`new-template-${code}`)).toHaveAttribute('lang', code);
    }
  } finally {
    await cleanupByEmail(email);
  }
});

// #3283: text PEOPLE write carries a `lang` only when it is known (an
// announcement translation filed under a locale) or detected with confidence
// (src/lib/contentLanguage.ts). Short or ambiguous text gets NO attribute —
// a wrong lang is read in the wrong voice, which is worse than none.
test('user-written notes and announcements carry their language, and only when it is clear', async ({ page }) => {
  const mentorEmail = uniqueEmail('lang-mentor');
  const menteeEmail = uniqueEmail('lang-mentee');
  const pw = 'LangParts123';
  const stamp = Date.now();
  const turkish = `Merhaba, belgeleri bu hafta içinde göndereceğim ${stamp}.`;
  const short = `Ok ${stamp}`;
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Lang Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Lang Mentee');
  let announcementId: string | null = null;
  try {
    await prisma.user.update({ where: { id: mentor.id }, data: { preferredLanguage: 'de' } });
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId: mentor.orgId, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    await prisma.interactionLog.createMany({
      data: [
        { relationId: relation.id, date: new Date(), notes: turkish, type: 'Meeting' },
        { relationId: relation.id, date: new Date(), notes: short, type: 'Meeting' },
      ],
    });
    // Filed under de and en: the reader (preferredLanguage de) gets the German
    // body, whose language is KNOWN — even though it is far too short to detect.
    const announcement = await prisma.announcement.create({
      data: {
        text: `Hello ${stamp}`,
        translations: { en: `Hello ${stamp}`, de: `Hallo ${stamp}` },
        sentById: mentor.id,
        recipientCount: 0,
        orgId: mentor.orgId,
        status: 'SENT',
      },
    });
    announcementId = announcement.id;

    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    await gotoSettled(page, '/mentor/interactions');
    // The list is fetched client-side; the first fetch compiles the route in dev.
    await expect(page.getByText(turkish, { exact: true })).toHaveAttribute('lang', 'tr', { timeout: 30_000 });
    const shortNote = page.getByText(short, { exact: true });
    await expect(shortNote).toBeVisible();
    expect(await shortNote.getAttribute('lang')).toBeNull();

    await gotoSettled(page, '/announcements');
    await expect(page.getByText(`Hallo ${stamp}`, { exact: true })).toHaveAttribute('lang', 'de', { timeout: 30_000 });
  } finally {
    if (announcementId) await prisma.announcement.deleteMany({ where: { id: announcementId } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
