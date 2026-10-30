import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { submitSignInForm, gotoSettled } from './helpers/auth';

// Screenshot baselines for the core screens (#1614): 7 screens × EN/TR/DE ×
// light/dark, compared with toHaveScreenshot(). The guard nothing else is: the
// a11y scan measures nine pages for axe rules and check:dark-mode reads class
// names, but a padding change, a Turkish label that wraps a header onto two
// lines or a component that composes its own colours only shows in pixels.
//
// DETERMINISM FIRST, or this is a flake factory:
//   · one fixed viewport, a viewport-sized capture (a full-page height follows
//     the data), animations and transitions off, the caret hidden;
//   · its own organisation and accounts with FIXED display names, so no other
//     spec's rows and no unique-email suffix reach the pixels;
//   · everything that is time or identity masked: <time> elements, the account
//     menu (it prints the e-mail), avatars, the nav's count badges (they count
//     rows other specs create) and the per-account referral code.
//
// BASELINES COME ONLY FROM THE CI IMAGE. Font rasterisation differs between a
// laptop and the GitHub runner, so a locally generated PNG would fail in CI on
// every run. They are produced by .github/workflows/visual-baselines.yml
// (workflow_dispatch), which pushes them to a branch for a PR; a baseline
// update is reviewed like code (docs/testing.md, "Visual regression").
//
// Until those baselines are committed this spec SKIPS itself, so the scheduled
// full suite it lives in cannot go red on a missing PNG. It is deliberately not
// tagged @smoke.

const SNAPSHOT_DIR = `${__filename}-snapshots`;
const UPDATING = process.env.VISUAL_BASELINE_UPDATE === '1';
const LOCALES = ['en', 'tr', 'de'] as const;
const THEMES = ['light', 'dark'] as const;
const VIEWPORT = { width: 1280, height: 800 };
const PASSWORD = 'VisualPass123!';

test.skip(!UPDATING && !existsSync(SNAPSHOT_DIR), 'no visual baselines committed yet — generate them with visual-baselines.yml');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: VIEWPORT });

const FREEZE_CSS = `
  *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

async function prepare(page: Page, locale: string, theme: string) {
  await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
  await page.evaluate(({ l, th }) => {
    document.cookie = `locale=${l};path=/`;
    document.cookie = `theme=${th}; path=/; max-age=31536000`;
    try { localStorage.setItem('theme', th); } catch { /* ignore */ }
  }, { l: locale, th: theme });
}

async function snap(page: Page, path: string, name: string, theme: string) {
  await gotoSettled(page, path);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  // The theme has to have been applied, or a dark baseline is a light one twice.
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.01,
    mask: [
      page.locator('time'),
      page.getByTestId('account-menu-button'),
      page.locator('[data-testid*="avatar"], img[alt=""]'),
      // Counts the full suite's other specs move in the shared shard database
      // (the nav's attention badges). The first-run checklist is NOT masked:
      // since #3393 it counts this org's rows only, which this spec owns.
      page.locator([
        'notifications-unread-badge', 'messages-unread-badge', 'mentor-applications-badge',
        'admin-hiring-badge', 'admin-offers-badge', 'outbox-badge',
        // The referral code is minted per account, so a fresh run is a fresh code.
        'referral-url',
      ].map((id) => `[data-testid="${id}"]`).join(', ')),
    ],
  });
}

test('core screens match their baselines in EN/TR/DE × light/dark', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: 'Visual Baseline Org', slug: `visual-${stamp}` } });
  const adminEmail = uniqueEmail('visual-admin');
  const mentorEmail = uniqueEmail('visual-mentor');
  const menteeEmail = uniqueEmail('visual-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Visual Admin', org.id);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Visual Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Visual Mentee', org.id);
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'INTERVIEW_PENDING_250' },
  });

  const shots: { who: string; email: string; landing: string; paths: [string, string][] }[] = [
    { who: 'public', email: '', landing: '', paths: [['/', 'landing'], ['/auth/signin', 'signin']] },
    { who: 'admin', email: adminEmail, landing: '/admin', paths: [['/admin', 'admin'], ['/admin/board', 'admin-board'], ['/messages', 'messages']] },
    { who: 'mentor', email: mentorEmail, landing: '/mentor', paths: [['/mentor', 'mentor']] },
    { who: 'mentee', email: menteeEmail, landing: '/portal', paths: [['/portal', 'portal']] },
  ];

  try {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        for (const group of shots) {
          // Only the session goes: a blanket clearCookies() would drop the
          // cookie-consent state too and put the banner into every baseline.
          await page.context().clearCookies({ name: /session-token/ });
          await page.goto('/auth/signin');
          await prepare(page, locale, theme);
          if (group.email) {
            await submitSignInForm(page, group.email, PASSWORD);
            // Longer than signInAsFreshUser's 20 s: under `next dev` a role's
            // first landing compiles on demand (CI serves a production build).
            await page.waitForURL((u) => u.pathname.startsWith(group.landing), { timeout: 90_000 });
            await page.getByTestId('account-menu-button').waitFor({ state: 'visible', timeout: 20_000 });
          }
          for (const [path, name] of group.paths) {
            await snap(page, path, `${name}-${locale}-${theme}`, theme);
          }
        }
      }
    }
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: relation.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
