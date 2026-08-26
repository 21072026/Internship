import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * Phone-width layout audit across the role shells (#1305).
 *
 * The bug that prompted this: on /admin/mentors the two Turkish action labels
 * ("Uzmanlığı düzenle" + "Pasifleştir") sat in a `flex-shrink-0` column opposite
 * the mentor's identity, so on a 360px phone the name/email column was squeezed
 * to ~18px — the row showed "E·" and the expertise chips ran under the buttons.
 * Nothing overflowed the *page*, so the existing sideways-scroll check missed it.
 *
 * Four mechanical rules, in the order they catch things:
 *   1. the page must not scroll sideways;
 *   2. nothing visible may reach past the right edge of the screen (unless it
 *      lives in a container that scrolls horizontally — a wide table inside
 *      `overflow-x-auto` is reachable, not broken);
 *   3. no box may spill its own content sideways — that is how a squeezed row
 *      announces itself even when the page still fits;
 *   4. a truncating text box narrower than 110px is not readable; the buttons
 *      next to it are what pushed it there.
 *
 * The audit runs in Turkish and German because those dictionaries carry the
 * longest labels — several of the rows this spec covers fit in English and only
 * break once translated.
 */

const PHONE = { width: 360, height: 800 };
// The tier nothing measured (#828): between `sm:` and `lg:`, where the sidebar is
// still hidden but two-column grids have already switched on. 768 is exactly
// Tailwind's `md:` breakpoint, so it is the first width at which `md:` rules
// apply — the worst case for a layout that assumes `md:` implies "roomy".
const TABLET = { width: 768, height: 1024 };
// Narrower than this and a truncated label stops carrying information.
const MIN_TEXT_WIDTH = 110;

async function setLocale(page: Page, locale: 'tr' | 'de') {
  // Same trick as i18n-coverage.spec: the cookie wins over the user preference,
  // and it needs an origin to be set on, hence the navigation first.
  await page.goto('/auth/signin');
  await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
}

/** Let the client-side lists land before measuring a half-empty page. */
async function settle(page: Page) {
  await page.getByTestId('account-menu-button').waitFor({ state: 'visible', timeout: 20_000 });
  // Every list on these pages renders SkeletonRows while it fetches; waiting for
  // the last one to go is more reliable than `networkidle`, which these shells
  // never reach (see helpers/auth.ts).
  await expect
    .poll(async () => page.locator('.animate-pulse').count(), { timeout: 20_000 })
    .toBe(0);
}

async function auditLayout(page: Page) {
  return page.evaluate((minTextWidth) => {
    const problems: string[] = [];
    const viewport = window.innerWidth;
    // 1px of slack: sub-pixel rounding on scaled layouts is not an overflow.
    if (document.documentElement.scrollWidth > viewport + 1) {
      problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${viewport}px`);
    }

    const describe = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      const cls = (el.getAttribute('class') || '').split(' ').slice(0, 4).join('.');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
    };

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      // Screen-reader-only helpers are a 1px box by design.
      if (/(^|\s)sr-only(\s|$)/.test(el.getAttribute('class') || '')) continue;

      let inScroller = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(a).overflowX)) { inScroller = true; break; }
      }

      if (rect.right > viewport + 1 && style.position !== 'fixed' && !inScroller) {
        problems.push(`${describe(el)} reaches ${Math.round(rect.right)}px, past the ${viewport}px screen`);
      }

      // A child pulled out with a negative margin (row hover backgrounds bleeding
      // into the card padding) widens scrollWidth on purpose.
      const negativeMargin = Array.from(el.children).some((c) => {
        const cs = getComputedStyle(c);
        return parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0;
      });
      const spills =
        el.scrollWidth > el.clientWidth + 4 &&
        el.clientWidth > 0 &&
        !negativeMargin &&
        !/auto|scroll/.test(style.overflowX) &&
        style.overflow !== 'hidden' &&
        // Text scrolling inside a form control is normal.
        !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      if (spills) {
        problems.push(`${describe(el)} spills its content: ${el.clientWidth}px box, ${el.scrollWidth}px content`);
      }

      const text = (el.textContent || '').trim();
      const isLeaf = !Array.from(el.children).some((c) => (c.textContent || '').trim().length > 0);
      if (
        isLeaf &&
        text.length > 3 &&
        el.clientWidth > 0 &&
        el.clientWidth < minTextWidth &&
        el.scrollWidth > el.clientWidth + 6 &&
        !/auto|scroll/.test(style.overflowX)
      ) {
        problems.push(`${describe(el)} is ${el.clientWidth}px wide for "${text.slice(0, 30)}"`);
      }
    }
    return [...new Set(problems)];
  }, MIN_TEXT_WIDTH);
}

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

    for (const path of ['/admin', '/admin/mentors', '/admin/activity']) {
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
