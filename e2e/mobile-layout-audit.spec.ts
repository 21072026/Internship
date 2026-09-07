import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import {
  PHONE,
  TABLET,
  REFLOW,
  ZOOM_400,
  auditLayout,
  setLocale,
  settle,
  settlePublic,
  sidewaysScroll,
} from './helpers/layoutAudit';

/**
 * Phone-width layout audit across the role shells (#1305).
 *
 * The bug that prompted this: on /admin/mentors the two Turkish action labels
 * ("Uzmanlığı düzenle" + "Pasifleştir") sat in a `flex-shrink-0` column opposite
 * the mentor's identity, so on a 360px phone the name/email column was squeezed
 * to ~18px — the row showed "E·" and the expertise chips ran under the buttons.
 * Nothing overflowed the *page*, so the existing sideways-scroll check missed it.
 *
 * The four mechanical rules, the viewport constants and the readiness helpers all
 * live in `e2e/helpers/layoutAudit.ts` — shared with the coverage sweep that
 * measures the rest of the product (`e2e/mobile-layout-coverage.spec.ts`, #1615),
 * so the two files can never end up measuring different things.
 *
 * The audit runs in Turkish and German because those dictionaries carry the
 * longest labels — several of the rows this spec covers fit in English and only
 * break once translated.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('phone width: the admin rows keep the person identifiable', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mobile-audit-admin');
  const mentorEmail = uniqueEmail('mobile-audit-mentor-with-a-long-address');
  const pw = 'MobileAudit123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'Mobile Audit Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Mobile Audit Mentor (Mentor)');
  // Expertise chips are part of the squeezed row, and an over-capacity mentor
  // also renders the warning badge next to the actions.
  await prisma.user.update({
    where: { id: mentor.id },
    data: { skills: ['TypeScript', 'Next.js', 'Data Engineering'], mentorCapacity: 2 },
  });

  try {
    await page.setViewportSize(PHONE);
    await setLocale(page, 'tr');
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // The mentor DETAIL page is in the loop because its header carries four
    // controls with long Turkish labels since #2268 (capacity badge, message,
    // view-as, convert) — the audit only ever measured the list (#1305).
    for (const path of ['/admin', '/admin/mentors', `/admin/mentors/${mentor.id}`, '/admin/activity']) {
      await gotoSettled(page, path);
      await settle(page);
      expect(await auditLayout(page), `${path} at ${PHONE.width}px (tr)`).toEqual([]);
    }

    // The seeded mentor is actually identifiable, not truncated to an initial.
    await gotoSettled(page, '/admin/mentors');
    await settle(page);
    await expect(page.getByText(mentorEmail)).toBeVisible();

    // A dialog is where a cramped row hides: nothing measures a form that is
    // not open yet.
    await page.getByRole('button', { name: /Uzmanlığı düzenle/i }).first().click();
    await expect(page.getByRole('button', { name: /^Kaydet$/i })).toBeVisible();
    expect(await auditLayout(page), 'the expertise dialog at 360px (tr)').toEqual([]);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: { in: [adminEmail, mentorEmail] } } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('phone width: the admin screens stay inside the viewport in German', async ({ page }) => {
  const adminEmail = uniqueEmail('mobile-sweep-admin');
  const pw = 'MobileAudit123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'Mobile Sweep Admin');

  try {
    await page.setViewportSize(PHONE);
    // German: the longest labels in the three dictionaries. /admin/analytics and
    // /admin/support only overflowed once translated.
    await setLocale(page, 'de');
    await signInAndSettle(page, adminEmail, pw, '/admin');

    for (const path of [
      '/admin/users',
      '/admin/candidates',
      '/admin/companies',
      '/admin/mentorship',
      '/admin/analytics',
      '/admin/support',
    ]) {
      await gotoSettled(page, path);
      await settle(page);
      expect(await auditLayout(page), `${path} at ${PHONE.width}px (de)`).toEqual([]);
    }
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: adminEmail } });
    await cleanupByEmail(adminEmail);
  }
});

test('phone width: the mentor screens stay inside the viewport in German', async ({ page }) => {
  const mentorEmail = uniqueEmail('mobile-sweep-mentor');
  const menteeEmail = uniqueEmail('mobile-sweep-mentee-with-a-long-address');
  const pw = 'MobileAudit123!';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Mobile Sweep Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Mobile Sweep Mentee');
  // A mentee card carries the identity block, the chips and the three actions —
  // the row that clipped "view details" at the card edge.
  await prisma.user.update({
    where: { id: mentee.id },
    data: {
      skills: ['React', 'JavaScript'],
      university: 'Orta Doğu Teknik Üniversitesi',
      department: 'Bilgisayar Mühendisliği',
    },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.setViewportSize(PHONE);
    await setLocale(page, 'de');
    await signInAndSettle(page, mentorEmail, pw, '/mentor');

    for (const path of ['/mentor', '/mentor/mentees', '/mentor/analytics']) {
      await gotoSettled(page, path);
      await settle(page);
      expect(await auditLayout(page), `${path} at ${PHONE.width}px (de)`).toEqual([]);
    }
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { actorEmail: mentorEmail } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('tablet width: the md: breakpoint does not break the role shells', async ({ page }) => {
  // 768px is where `md:` turns on but the `lg:` sidebar has not: a two-column
  // grid inside a full-width main is the shape most likely to overflow, and no
  // spec had ever measured it (every viewport in the suite was a phone or a
  // desktop). German again, for the longest labels.
  const adminEmail = uniqueEmail('tablet-audit-admin');
  const pw = 'MobileAudit123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'Tablet Audit Admin');

  try {
    await page.setViewportSize(TABLET);
    await setLocale(page, 'de');
    await signInAndSettle(page, adminEmail, pw, '/admin');

    for (const path of ['/admin', '/admin/candidates', '/admin/mentors', '/admin/analytics']) {
      await gotoSettled(page, path);
      await settle(page);
      expect(await auditLayout(page), `${path} at ${TABLET.width}px (de)`).toEqual([]);
    }
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: adminEmail } });
    await cleanupByEmail(adminEmail);
  }
});

test('phone width: the profile pages hold together', async ({ page }) => {
  // /portal/profile and /mentor/profile are the longest forms in the product and
  // were never measured at phone width — the audit covered dashboards and lists
  // only (#828). A form is where a label/field pair squeezes first.
  const menteeEmail = uniqueEmail('profile-audit-mentee');
  const mentorEmail = uniqueEmail('profile-audit-mentor');
  const pw = 'MobileAudit123!';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Profil Denetimi Mentee');
  await seedUser(mentorEmail, pw, 'MENTOR', 'Profil Denetimi Mentor');
  await prisma.user.update({
    where: { id: mentee.id },
    data: {
      skills: ['TypeScript', 'React', 'Datenbankmodellierung'],
      university: 'Orta Doğu Teknik Üniversitesi',
      department: 'Bilgisayar Mühendisliği',
    },
  });

  try {
    await page.setViewportSize(PHONE);
    await setLocale(page, 'de');
    await signInAndSettle(page, menteeEmail, pw, '/portal');
    await gotoSettled(page, '/portal/profile');
    await settle(page);
    expect(await auditLayout(page), `/portal/profile at ${PHONE.width}px (de)`).toEqual([]);

    await page.context().clearCookies();
    await setLocale(page, 'de');
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    await gotoSettled(page, '/mentor/profile');
    await settle(page);
    expect(await auditLayout(page), `/mentor/profile at ${PHONE.width}px (de)`).toEqual([]);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: { in: [menteeEmail, mentorEmail] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('phone width in dark mode: the retint does not change the geometry', async ({ page }) => {
  // Dark mode and a phone viewport had never been combined (#828). They are not
  // independent: globals.css retints by REMAPPING utility classes, and a rule
  // that swaps a border for a ring, or a background for one with a different
  // padding, moves boxes. This measures the same four rules with `.dark` on.
  const adminEmail = uniqueEmail('dark-phone-admin');
  const pw = 'MobileAudit123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'Dark Phone Admin');

  try {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ colorScheme: 'dark' });
    await setLocale(page, 'de');
    await page.evaluate(() => {
      document.cookie = 'theme=dark; path=/; max-age=31536000';
      try { localStorage.setItem('theme', 'dark'); } catch { /* ignore */ }
    });
    await signInAndSettle(page, adminEmail, pw, '/admin');

    for (const path of ['/admin', '/admin/candidates', '/admin/board']) {
      await gotoSettled(page, path);
      await settle(page);
      // The retint has to have actually happened, or this test measures light
      // mode twice and passes for the wrong reason.
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      expect(await auditLayout(page), `${path} at ${PHONE.width}px (de, dark)`).toEqual([]);
    }
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: adminEmail } });
    await cleanupByEmail(adminEmail);
  }
});

test('phone width: /release-notes fits, one release per card', async ({ page }) => {
  // Public, no sign-in. Each release now carries a meta line — the version on
  // one side, "2026-08-25 09:25 UTC · b174c20" on the other (#1457) — which is
  // wider than 360px if the row is not allowed to stack. German because its
  // release-note strings are the longest.
  await page.setViewportSize(PHONE);
  await setLocale(page, 'de');
  await gotoSettled(page, '/release-notes');
  await settlePublic(page);
  expect(await auditLayout(page), `/release-notes at ${PHONE.width}px (de)`).toEqual([]);
});

test('reflow: the board and the calendar survive 320px and 400% zoom', async ({ page }) => {
  // WCAG 1.4.10 (#2047). The rest of this file measures 360px and up; 320 is the
  // width the success criterion actually names, and the board (13 stage columns)
  // and the calendar (a seven-column month grid + a four-tab view switcher) are
  // the two surfaces most likely to demand a sideways scroll of the whole page.
  //
  // Both locales, because the calendar's view switcher is exactly where the
  // longest translations land: "Aylık/Haftalık/Günlük/Yaklaşan" (tr) and
  // "Monat/Woche/Tag/Demnächst" (de) do not fit on one 320px line, and the strip
  // is expected to WRAP rather than scroll.
  const adminEmail = uniqueEmail('reflow-admin');
  const mentorEmail = uniqueEmail('reflow-mentor');
  const menteeEmail = uniqueEmail('reflow-mentee');
  const pw = 'MobileAudit123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'Reflow Audit Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Reflow Audit Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Reflow Audit Mentee');
  // A board with nothing on it renders an empty state, not columns — seed one
  // relation so the measurement is of the real thing.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  const sweep = async (paths: string[], locale: 'tr' | 'de') => {
    for (const viewport of [REFLOW, ZOOM_400]) {
      await page.setViewportSize(viewport);
      for (const path of paths) {
        await gotoSettled(page, path);
        await settle(page);
        expect(
          await sidewaysScroll(page),
          `${path} at ${viewport.width}x${viewport.height} (${locale})`
        ).toBeNull();
      }
    }
  };

  try {
    await page.setViewportSize(REFLOW);
    await setLocale(page, 'de');
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await sweep(['/admin/board', '/admin/calendar'], 'de');

    // The view switcher specifically: it used to answer the overflow with
    // `overflow-x-auto`, which is a sideways scroll inside a control that has no
    // reason to need one. It now wraps, so it must fit its own box.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
    expect(
      await tablist.evaluate((el) => el.scrollWidth - el.clientWidth),
      'the calendar view switcher scrolls sideways at 320px (de)'
    ).toBeLessThanOrEqual(1);

    // Turkish carries the longest calendar labels of the three dictionaries.
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await sweep(['/admin/board', '/admin/calendar'], 'tr');

    await page.context().clearCookies();
    await page.setViewportSize(REFLOW);
    await setLocale(page, 'de');
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    await sweep(['/mentor/board', '/mentor/calendar'], 'de');
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({
      where: { actorEmail: { in: [adminEmail, mentorEmail, menteeEmail] } },
    });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
