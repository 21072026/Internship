import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * #1415 — the JourneyTracker's upcoming stages were under AA in BOTH themes.
 *
 * This is the first card a mentee sees, and the "future" rows are most of it:
 * gray-400 on white is 2.54:1, and in dark the badge came out 2.13:1 because
 * globals.css remaps `bg-gray-100` to #374151 while the element's own
 * `dark:bg-gray-800` never applied.
 *
 * Why the existing a11y gate never caught it: e2e/a11y-scan.spec.ts signs in a
 * fresh mentee with NO MentorshipRelation, and JourneyTracker only renders when
 * there is one. The scanned /portal is the empty state — so these selectors are
 * absent from the baseline entirely, not merely frozen in it.
 *
 * axe measures the COMPOSITED colour, which is the only way to catch an inert
 * `dark:` variant: the class is present in the markup either way.
 */

const password = 'Contrast1415Pass!';

async function forceTheme(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.evaluate((theme) => {
    document.cookie = `theme=${theme}; path=/; max-age=31536000`;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, dark ? 'dark' : 'light');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

async function expectNoContrastViolation(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2aa', 'wcag22aa'])
    .analyze();
  const contrast = results.violations.filter((v) => v.id === 'color-contrast');
  expect(
    contrast.map((v) => v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`)),
    `contrast violations under ${selector}`
  ).toEqual([]);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('issue #1415 journey tracker stages meet AA contrast in both themes', async ({ page }) => {
  const menteeEmail = uniqueEmail('contrast-1415-mentee');
  const mentorEmail = uniqueEmail('contrast-1415-mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Contrast 1415 Mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Contrast 1415 Mentor');
  // The tracker only renders with a relation, and the earliest stage leaves
  // almost every row in the "future" state — the one that was unreadable.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await signInAsFreshUser(page, menteeEmail, password, '/portal');

    for (const dark of [false, true]) {
      await page.goto('/portal');
      await forceTheme(page, dark);

      const future = page.locator('[data-testid="journey-stage-label"][data-stage-state="future"]');
      await expect(future.first(), `future stages should render in ${dark ? 'dark' : 'light'}`).toBeVisible();

      // Each state separately, so a failure names which one regressed rather
      // than "something in the tracker".
      for (const state of ['future', 'current', 'done'] as const) {
        const labels = page.locator(`[data-testid="journey-stage-label"][data-stage-state="${state}"]`);
        if (await labels.count()) {
          await expectNoContrastViolation(page, `[data-testid="journey-stage-label"][data-stage-state="${state}"]`);
        }
        const badges = page.locator(`[data-testid="journey-stage-badge"][data-stage-state="${state}"]`);
        if (await badges.count()) {
          await expectNoContrastViolation(page, `[data-testid="journey-stage-badge"][data-stage-state="${state}"]`);
        }
      }
    }
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
