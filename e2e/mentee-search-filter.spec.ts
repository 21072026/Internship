import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #1367 — finding one mentee among many, on both mentor surfaces.
 *
 * Locator discipline (CLAUDE.md): `MentorNav` renders its own sidebar
 * `input[type="search"]`, so every search box here is addressed by its
 * `data-testid` and never by the input type. Name assertions are scoped to the
 * list/column container and use `{ exact: true }`, because `getByText()`
 * substring-matches and these fixtures deliberately share word fragments.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'MentorPass123';

async function signInAsMentor(page: import('@playwright/test').Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
}

test('mentee list filters by name, status and stage, and offers a way out of an empty result', async ({ page }) => {
  const mentorEmail = uniqueEmail('msf-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Search Mentor');
  // Three deliberately unalike names: one plain, one carrying Turkish
  // diacritics (typed back in ASCII below), one that must stay out of the way.
  const zephyr = await seedUser(uniqueEmail('msf-zephyr'), 'x', 'MENTEE', 'Zephyr Quicksilver');
  const sevval = await seedUser(uniqueEmail('msf-sevval'), 'x', 'MENTEE', 'Şevval Işıkdemir');
  const barnaby = await seedUser(uniqueEmail('msf-barnaby'), 'x', 'MENTEE', 'Barnaby Wintergreen');

  const relZephyr = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: zephyr.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });
  const relSevval = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: sevval.id, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  const relBarnaby = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: barnaby.id, status: 'COMPLETED', pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await signInAsMentor(page, mentorEmail);
    await page.goto('/mentor/mentees');

    const list = page.getByTestId('mentee-list');
    await expect(list.getByText('Zephyr Quicksilver', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mentee-card-${relSevval.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentee-card-${relBarnaby.id}`)).toBeVisible();

    // Name search narrows to one card.
    const search = page.getByTestId('mentee-search');
    await search.fill('quicksilver');
    await expect(page.getByTestId(`mentee-card-${relZephyr.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentee-card-${relSevval.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`mentee-card-${relBarnaby.id}`)).toHaveCount(0);

    // Typed in ASCII, the accented name is still found (src/lib/menteeFilter.ts).
    await search.fill('isikdemir');
    await expect(page.getByTestId(`mentee-card-${relSevval.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentee-card-${relZephyr.id}`)).toHaveCount(0);

    // No match → its own empty state, whose action clears the filters.
    await search.fill('zzz-nobody-by-that-name');
    await expect(page.getByTestId('empty-mentor-mentees-no-match')).toBeVisible();
    await page.getByTestId('empty-mentor-mentees-no-match').getByRole('button').click();
    await expect(page.getByTestId(`mentee-card-${relZephyr.id}`)).toBeVisible();
    await expect(search).toHaveValue('');

    // Status filter: only the completed mentorship survives.
    await page.getByTestId('mentee-status-filter-COMPLETED').click();
    await expect(page.getByTestId(`mentee-card-${relBarnaby.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentee-card-${relZephyr.id}`)).toHaveCount(0);
    await page.getByTestId('mentee-status-filter-ALL').click();

    // Stage filter: options are the org's resolved stages, selected by key.
    await page.getByTestId('mentee-stage-filter').selectOption('INTERNSHIP_IN_PROGRESS_450');
    await expect(page.getByTestId(`mentee-card-${relSevval.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentee-card-${relZephyr.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`mentee-card-${relBarnaby.id}`)).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({
      where: { id: { in: [relZephyr.id, relSevval.id, relBarnaby.id] } },
    });
    await cleanupByEmail(zephyr.email);
    await cleanupByEmail(sevval.email);
    await cleanupByEmail(barnaby.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentor board search hides non-matching cards and re-counts the columns', async ({ page }) => {
  const mentorEmail = uniqueEmail('msb-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Board Search Mentor');
  const keeper = await seedUser(uniqueEmail('msb-keeper'), 'x', 'MENTEE', 'Peregrine Halloway');
  const other = await seedUser(uniqueEmail('msb-other'), 'x', 'MENTEE', 'Xanthe Brightwater');

  const relKeeper = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: keeper.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });
  const relOther = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: other.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await signInAsMentor(page, mentorEmail);
    await page.goto('/mentor/board');

    const column = page.getByTestId('board-column-APPLICATION_100');
    const count = page.getByTestId('board-column-count-APPLICATION_100');
    await expect(column.getByText('Peregrine Halloway', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText('2');

    // The search narrows the cards AND the column's own count badge, so the
    // number always describes what is on screen.
    await page.getByTestId('mentor-board-search').fill('peregrine');
    await expect(column.getByText('Peregrine Halloway', { exact: true })).toBeVisible();
    await expect(column.getByText('Xanthe Brightwater', { exact: true })).toHaveCount(0);
    await expect(count).toHaveText('1');

    // Nothing matches at all: the columns stay, the board says so.
    await page.getByTestId('mentor-board-search').fill('zzz-nobody-by-that-name');
    await expect(page.getByTestId('mentor-board-no-match')).toBeVisible();
    await expect(count).toHaveText('0');
    await expect(page.getByTestId('board-card')).toHaveCount(0);

    await page.getByTestId('mentor-board-search').fill('');
    await expect(count).toHaveText('2');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relKeeper.id, relOther.id] } } });
    await cleanupByEmail(keeper.email);
    await cleanupByEmail(other.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('a dormant mentee is still findable by name — the empty state offers the toggle, not "clear filters"', async ({ page }) => {
  const mentorEmail = uniqueEmail('msd-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Dormant Search Mentor');
  const quiet = await seedUser(uniqueEmail('msd-quiet'), 'x', 'MENTEE', 'Şevval Işıkdemir');
  const loud = await seedUser(uniqueEmail('msd-loud'), 'x', 'MENTEE', 'Zephyr Quicksilver');

  // Stamped the way the daily sweep stamps it (docs/dormant-first-contacts.md),
  // so this row is behind the "Show dormant" toggle in its default state.
  const relQuiet = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: quiet.id,
      status: 'ACTIVE',
      pipelineStatus: 'APPLICATION_100',
      dormantSince: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      dormantNudgeCount: 1,
    },
  });
  const relLoud = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: loud.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await signInAsMentor(page, mentorEmail);
    await page.goto('/mentor/mentees');

    // Default state: the dormant row is hidden, the other one is not.
    await expect(page.getByTestId(`mentee-card-${relLoud.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mentee-card-${relQuiet.id}`)).toHaveCount(0);

    // Searching her name used to render "clear the filters to see everyone
    // again" over a Clear-filters button that brought back everyone except her.
    const search = page.getByTestId('mentee-search');
    await search.fill('isikdemir');
    const empty = page.getByTestId('empty-mentor-mentees-no-match');
    await expect(empty).toBeVisible();
    await empty.getByRole('button').click();
    // The toggle flipped rather than the filters clearing: her card is on
    // screen, still badged dormant, and the query is untouched.
    await expect(page.getByTestId(`mentee-card-${relQuiet.id}`)).toBeVisible();
    await expect(page.getByTestId(`dormant-badge-${relQuiet.id}`)).toBeVisible();
    await expect(search).toHaveValue('isikdemir');
    await expect(page.getByTestId(`mentee-card-${relLoud.id}`)).toHaveCount(0);

    // Hide them again and search something both rows share: the visible match
    // renders, and the banner says a hidden dormant row matches too.
    await page.getByTestId('toggle-dormant-mentees').click();
    await search.fill('e');
    await expect(page.getByTestId('mentee-dormant-matches')).toBeVisible();
    await page.getByTestId('show-dormant-matches').click();
    await expect(page.getByTestId(`mentee-card-${relQuiet.id}`)).toBeVisible();
    await expect(page.getByTestId('mentee-dormant-matches')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relQuiet.id, relLoud.id] } } });
    await cleanupByEmail(quiet.email);
    await cleanupByEmail(loud.email);
    await cleanupByEmail(mentorEmail);
  }
});
