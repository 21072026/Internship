import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #936 — the board was unusable on a phone: 13 stage columns scrolled sideways
 * (only ~1.2 fit at 390px) and drag-and-drop was the only way to change a stage,
 * which touch does not fire at all.
 *
 * Below `lg:` both boards now render a stage filter plus a single-column list, and
 * every card carries a "Move to stage" select (touch *and* keyboard). Drag-and-drop
 * is untouched on desktop.
 */

const PHONE = { width: 390, height: 800 };
const DESKTOP = { width: 1024, height: 800 };

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

const overflowX = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function seedRelation(prefix: string, role: 'MENTOR' | 'ADMIN') {
  const ownerEmail = uniqueEmail(`${prefix}-${role.toLowerCase()}`);
  const mentorEmail = role === 'MENTOR' ? ownerEmail : uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const password = 'BoardMobile123!';
  const owner = await seedUser(ownerEmail, password, role, `${prefix} Owner`);
  const mentor = role === 'MENTOR' ? owner : await seedUser(mentorEmail, password, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', `${prefix} Mentee`);
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' },
  });
  const cleanup = async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const email of new Set([ownerEmail, mentorEmail, menteeEmail])) await cleanupByEmail(email);
  };
  return { ownerEmail, password, relation, cleanup };
}

const stageOf = (id: string) =>
  prisma.mentorshipRelation.findUnique({ where: { id } }).then((r) => r?.pipelineStatus);

test('mentor board on a phone: stage list, no sideways scrolling, stage change without dragging', async ({ page }) => {
  const { ownerEmail, password, relation, cleanup } = await seedRelation('bm', 'MENTOR');

  try {
    await page.setViewportSize(PHONE);
    await signIn(page, ownerEmail, password, '/mentor');
    await page.goto('/mentor/board');

    // List view, not the 13-column kanban.
    await expect(page.getByTestId('board-mobile')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('board-stage-filter')).toBeVisible();
    // `div.w-64` would also match the app-shell sidebar, hence the testid.
    await expect(page.getByTestId('board-columns')).toHaveCount(0);
    expect(await overflowX(page)).toBe(0);

    // The filter opens on the first stage that has anyone in it.
    await expect(page.getByTestId('board-stage-filter')).toHaveValue('APPLICATION_100');
    await expect(page.getByText('bm Mentee')).toBeVisible();

    // Stage change by touch: the per-card select, no drag involved.
    const card = page.getByTestId('board-card').filter({ hasText: 'bm Mentee' });
    await card.getByLabel('Move to stage').selectOption('INTERNSHIP_IN_PROGRESS_450');
    await expect.poll(() => stageOf(relation.id), { timeout: 10_000 }).toBe('INTERNSHIP_IN_PROGRESS_450');

    // The filter stays put, so the card visibly leaves the stage you were looking at.
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('board-stage-filter')).toHaveValue('APPLICATION_100');
    await expect(page.getByText('No mentees in this stage')).toBeVisible();

    // …and the move can be taken back from the toast.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => stageOf(relation.id), { timeout: 10_000 }).toBe('APPLICATION_100');
    await expect(page.getByText('bm Mentee')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('mentor board keeps its columns and per-card stage select on desktop', { tag: '@smoke' }, async ({ page }) => {
  const { ownerEmail, password, relation, cleanup } = await seedRelation('bd', 'MENTOR');

  try {
    await page.setViewportSize(DESKTOP);
    await signIn(page, ownerEmail, password, '/mentor');
    await page.goto('/mentor/board');

    // Columns are still the desktop layout (drag-and-drop targets), no list view.
    await expect(page.getByTestId('board-columns')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('board-mobile')).toHaveCount(0);

    await expect(page.getByTestId('board-columns-right-hint')).toBeVisible();
    await expect(page.getByTestId('board-columns-left-hint')).toHaveCount(0);
    await page.getByTestId('board-columns').evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByTestId('board-columns-left-hint')).toBeVisible();
    await expect(page.getByTestId('board-columns-right-hint')).toHaveCount(0);

    await page.setViewportSize({ width: 5000, height: 800 });
    await expect(page.getByTestId('board-columns-left-hint')).toHaveCount(0);
    await expect(page.getByTestId('board-columns-right-hint')).toHaveCount(0);

    // Same keyboard-accessible stage select the admin board already had.
    const card = page.getByTestId('board-card').filter({ hasText: 'bd Mentee' });
    await card.getByLabel('Move to stage').selectOption('INTERVIEW_PENDING_250');
    await expect.poll(() => stageOf(relation.id), { timeout: 10_000 }).toBe('INTERVIEW_PENDING_250');
  } finally {
    await cleanup();
  }
});

test('admin board on a phone: stage list at 390px and no overflow at 320px', async ({ page }) => {
  const { ownerEmail, password, relation, cleanup } = await seedRelation('ba-m', 'ADMIN');

  try {
    await page.setViewportSize(PHONE);
    await signIn(page, ownerEmail, password, '/admin');
    await page.goto('/admin/board');

    await expect(page.getByTestId('board-mobile')).toBeVisible({ timeout: 10_000 });
    // `div.w-64` would also match the app-shell sidebar, hence the testid.
    await expect(page.getByTestId('board-columns')).toHaveCount(0);
    expect(await overflowX(page)).toBe(0);

    const card = page.getByTestId('board-card').filter({ hasText: 'ba-m Mentee' });
    await card.getByLabel('Move to stage').selectOption('HIRED_660');
    await expect.poll(() => stageOf(relation.id), { timeout: 10_000 }).toBe('HIRED_660');

    // The narrowest phone we support.
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await overflowX(page)).toBe(0);
  } finally {
    await cleanup();
  }
});

/**
 * Custom pipelines on the board (#828).
 *
 * The phone list reads the viewer's RESOLVED stages, but the desktop admin board
 * used to iterate the hardcoded `PIPELINE_GROUPS` constant — so an org that had
 * renamed its pipeline saw its stages on a phone and nothing on a desktop. The
 * suite never seeded a custom stage set, so nothing caught it. These two cases
 * are the extremes: a 3-stage org (fewer stages than the constant) and a
 * 13-stage org whose keys share none of the built-ins.
 */
async function seedCustomOrg(prefix: string, stageCount: number) {
  const org = await prisma.organization.create({
    data: { slug: `${prefix}-${Date.now()}`, name: `${prefix} Org` },
  });
  const keys = Array.from({ length: stageCount }, (_, i) => `${prefix.toUpperCase()}_STAGE_${i + 1}`);
  await prisma.pipelineStage.createMany({
    data: keys.map((key, i) => ({
      orgId: org.id,
      key,
      label: `${prefix} Aşama ${i + 1}`,
      order: i,
      isTerminal: i === stageCount - 1,
      isOffPath: false,
    })),
  });

  const password = 'BoardCustom123!';
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const admin = await seedUser(adminEmail, password, 'ADMIN', `${prefix} Admin`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', `${prefix} Mentee`);
  for (const u of [admin, mentor, mentee]) {
    await prisma.user.update({ where: { id: u.id }, data: { orgId: org.id } });
  }
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, pipelineStatus: keys[0] },
  });

  const cleanup = async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { adminEmail, password, keys, relation, cleanup };
}

for (const stageCount of [3, 13]) {
  test(`admin board shows a ${stageCount}-stage custom pipeline on desktop and on a phone`, async ({ page }) => {
    const { adminEmail, password, keys, cleanup } = await seedCustomOrg(`bc${stageCount}`, stageCount);

    try {
      await page.setViewportSize(DESKTOP);
      await signIn(page, adminEmail, password, '/admin');
      await page.goto('/admin/board');
      await expect(page.getByTestId('board-columns')).toBeVisible({ timeout: 10_000 });

      // Every custom stage has a column. This is the assertion the old code
      // failed: iterating PIPELINE_GROUPS, none of these keys matched, so the
      // board rendered three empty group shells and no columns at all.
      const columns = page.getByTestId('board-columns');
      for (const [i] of keys.entries()) {
        await expect(columns.getByText(`bc${stageCount} Aşama ${i + 1}`, { exact: true })).toBeVisible();
      }
      // …and no built-in stage leaks in alongside them.
      await expect(columns.getByText('Application', { exact: true })).toHaveCount(0);

      // The phone list has always been right; assert it still is, so the fix
      // cannot be "make desktop match by breaking mobile".
      await page.setViewportSize(PHONE);
      await page.goto('/admin/board');
      await expect(page.getByTestId('board-mobile')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('board-stage-filter')).toHaveValue(keys[0]);
      expect(await overflowX(page)).toBe(0);
    } finally {
      await cleanup();
    }
  });
}
