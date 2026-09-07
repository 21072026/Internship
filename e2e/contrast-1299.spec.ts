import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * #1299 — white text on an accent surface too light to carry it.
 *
 * The issue was filed against six pages and six selectors, all of which had
 * been fixed by the time it was picked up (#1336/#1482, then the muted-text
 * token raise in #2131). What had not been fixed is the *pair*: a solid
 * `bg-<hue>-500`/`-600` under `text-white`. Fifteen call sites sat on it —
 * amber-500 at 2.15:1, green-500 2.28:1, amber-600 3.19:1, green-600 3.30:1,
 * red-500 3.76:1.
 *
 * Most of that surface is now guarded statically, in under a second, by
 * `npm run check:contrast` (scripts/check-contrast.mjs). This spec covers the
 * half a static check cannot claim: that the fix survives in the RENDERED
 * document, in both themes, with globals.css's remaps applied — the same reason
 * e2e/contrast-1415.spec.ts exists.
 *
 * Three nodes, picked so that between them they cover every token family the
 * fix touched and both of the failure modes the guard cannot see:
 *   - the public RSVP page's accept/decline pair (green-700 and red-600),
 *     reachable with no account at all — one page, two of the fifteen sites;
 *   - the notification bell's unread count (red-600), which lives in the shared
 *     role shell and is therefore the same node on /portal, /mentor and /admin;
 *   - `LanguageBadge`'s unset variant, the one fix in this change that is NOT a
 *     `text-white` pair (gray-400 on gray-100, 4.39:1 light / a gray-500 pin at
 *     3.04:1 dark). `check:contrast` only knows the white pair, so without this
 *     case the dark half of that fix would have no regression cover at all.
 *
 * Why e2e/a11y-scan.spec.ts did not catch any of them: the RSVP page needs a
 * meeting with a live token, the bell badge needs an unread notification, and
 * the badge's unset variant needs a candidate — none of which the scan's bare
 * per-role fixtures create.
 *
 * Locator note: the role shell renders `NotificationBell` TWICE — once in the
 * `lg:hidden` mobile bar and once in the `hidden lg:flex` desktop strip
 * (src/components/ResponsiveShell.tsx) — and the mobile one comes first in DOM
 * order. At this project's Desktop Chrome viewport `.first()` is therefore the
 * *hidden* node, which never becomes visible and which axe's color-contrast
 * rule skips outright (so the assertion would pass while measuring nothing).
 * Both the expectation and the axe include use a `:visible`-filtered selector,
 * the same way e2e/upcoming-meeting.spec.ts handles the duplicated
 * `join-meeting-pill`. `/admin/candidates` has the same shape for a different
 * reason — every candidate is rendered in both a mobile and a desktop list — so
 * the badge case is scoped to its own `candidate-card-<id>`.
 */

const password = 'Contrast1299Pass!';

async function forceTheme(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.evaluate((theme) => {
    document.cookie = `theme=${theme}; path=/; max-age=31536000`;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, dark ? 'dark' : 'light');
  // Reload rather than toggling the class: a document rendered light and then
  // given `.dark` is half-dark, and axe faithfully reports contrast failures
  // that no real user would ever see (same note as the a11y scan's forceDark).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

async function expectNoContrastViolation(page: Page, selector: string, theme: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2aa', 'wcag22aa'])
    .analyze();
  const contrast = results.violations.filter((v) => v.id === 'color-contrast');
  expect(
    contrast.map((v) => v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`)),
    `contrast violations under ${selector} in ${theme} mode`
  ).toEqual([]);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('issue #1299 the public RSVP buttons meet AA contrast in both themes', async ({ page }) => {
  const mentorEmail = uniqueEmail('contrast-1299-mentor');
  const menteeEmail = uniqueEmail('contrast-1299-rsvp-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Contrast 1299 Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Contrast 1299 RSVP Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  // The buttons render only while the RSVP is still PENDING and the meeting has
  // a time — a meeting with no `scheduledAt` is just a shared link and asks for
  // no answer. So the fixture is "a future, unanswered meeting".
  const meeting = await prisma.meeting.create({
    data: {
      relationId: relation.id,
      title: 'Contrast 1299 RSVP meeting',
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      createdById: mentor.id,
      rsvpToken: crypto.randomBytes(16).toString('hex'),
    },
  });

  try {
    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light';
      await page.goto(`/rsvp/${meeting.rsvpToken}`);
      await forceTheme(page, dark);
      // Both buttons are painted client-side once the token resolves, so wait
      // on the accept button rather than on the card around it.
      await expect(
        page.getByTestId('rsvp-accept'),
        `the RSVP accept button should render in ${theme}`
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('rsvp-decline')).toBeVisible();
      // green-700 (5.02:1) and red-600 (4.83:1) — two of the fifteen sites.
      await expectNoContrastViolation(page, '[data-testid="rsvp-accept"]', theme);
      await expectNoContrastViolation(page, '[data-testid="rsvp-decline"]', theme);
    }
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('issue #1299 the unread notification badge meets AA contrast in both themes', async ({ page }) => {
  test.slow();
  const email = uniqueEmail('contrast-1299-mentee');
  const mentee = await seedUser(email, password, 'MENTEE', 'Contrast 1299 Mentee');
  // The badge is rendered only for a non-zero unread count, so the count is the
  // fixture. Notification rows cascade with the user, so cleanup is the user.
  await prisma.notification.create({
    data: {
      userId: mentee.id,
      type: 'message.new',
      text: 'Seeded unread notification for the #1299 contrast spec.',
      link: '/messages',
      read: false,
    },
  });

  try {
    await signInAsFreshUser(page, email, password, '/portal');

    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light';
      await page.goto('/portal');
      await forceTheme(page, dark);
      // `:visible` is load-bearing for the Playwright locator — see the note
      // at the top of the file — but it is a Playwright-only pseudo-class:
      // AxeBuilder#include() resolves selectors with the browser's own
      // `document.querySelectorAll`, which throws on it ("':visible' is not
      // a valid selector"). axe's color-contrast rule already skips
      // non-visible nodes on its own, so the plain testid selector (matching
      // both the hidden mobile-bar badge and the visible desktop one) is
      // enough to scope the scan to the one node that actually renders.
      const badgeSelector = '[data-testid="notifications-unread-badge"]';
      const visibleBadge = `${badgeSelector}:visible`;
      await expect(
        page.locator(visibleBadge).first(),
        `the unread badge should render in ${theme}`
      ).toBeVisible({ timeout: 20_000 });
      await expectNoContrastViolation(page, badgeSelector, theme);
    }
  } finally {
    await cleanupByEmail(email);
  }
});

test('issue #1299 the unset LanguageBadge meets AA contrast in both themes', async ({ page }) => {
  test.slow();
  const adminEmail = uniqueEmail('contrast-1299-admin');
  const candidateEmail = uniqueEmail('contrast-1299-candidate');
  await seedUser(adminEmail, password, 'ADMIN', 'Contrast 1299 Admin');
  // `seedUser` leaves `preferredLanguage` null, which IS the unset variant —
  // the muted chip this change re-coloured. A candidate is any MENTEE.
  const candidate = await seedUser(candidateEmail, password, 'MENTEE', 'Contrast 1299 Candidate');

  try {
    await signInAsFreshUser(page, adminEmail, password, '/admin');

    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light';
      await page.goto('/admin/candidates');
      await forceTheme(page, dark);
      // Scoped to this candidate's own desktop card: /admin/candidates renders
      // every candidate twice (mobile + desktop lists), and other specs' seeded
      // mentees share the page, so an unscoped badge locator resolves to many.
      const card = page.getByTestId(`candidate-card-${candidate.id}`);
      await expect(card, `the candidate card should render in ${theme}`).toBeVisible({ timeout: 20_000 });
      const badge = card.locator('[data-language-set="false"]');
      await expect(badge, `the unset language badge should render in ${theme}`).toBeVisible();
      await expectNoContrastViolation(
        page,
        `[data-testid="candidate-card-${candidate.id}"] [data-language-set="false"]`,
        theme
      );
    }
  } finally {
    await cleanupByEmail(candidateEmail);
    await cleanupByEmail(adminEmail);
  }
});
