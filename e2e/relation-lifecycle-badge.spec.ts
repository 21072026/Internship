import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, seedMenteeWithRelation, cleanupMenteeWithRelation } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * The lifecycle badge and the PAUSED / ENDED list filters (#1774).
 *
 * A paused pair must not look like a live one: the badge says so in the
 * reader's language, the admin list can filter to it, an early end carries its
 * reason on hover for the admin, and the chip stays legible in dark mode.
 */

const PASSWORD = 'LifecycleBadge123!';

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a paused pair is labelled in EN and TR, filterable, and legible in dark mode', async ({ page, baseURL }) => {
  const paused = await seedMenteeWithRelation('lcbadge-p', PASSWORD);
  const ended = await seedMenteeWithRelation('lcbadge-e', PASSWORD);
  const adminEmail = uniqueEmail('lcbadge-admin');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Badge Admin');
  await prisma.mentorshipRelation.update({
    where: { id: paused.relationId },
    data: { lifecycleState: 'PAUSED', pausedAt: new Date() },
  });
  await prisma.mentorshipRelation.update({
    where: { id: ended.relationId },
    data: { status: 'COMPLETED', lifecycleState: 'ENDED_EARLY', endReasonCode: 'schedule_conflict', completedAt: new Date() },
  });
  try {
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/mentorship');

    // PAUSED filter: the paused pair is listed with its badge, the ended one is not.
    await page.getByTestId('mentorship-filter-PAUSED').click();
    const pausedRow = page.getByTestId(`mentorship-row-${paused.relationId}`);
    const badge = pausedRow.getByTestId('relation-lifecycle-badge');
    await expect(badge).toHaveText('Paused');
    await expect(badge).toHaveAttribute('data-state', 'PAUSED');
    await expect(page.getByTestId(`mentorship-row-${ended.relationId}`)).toHaveCount(0);

    // ENDED filter: the early end, with its reason on hover — never a "Completed".
    await page.getByTestId('mentorship-filter-ENDED').click();
    const endedBadge = page.getByTestId(`mentorship-row-${ended.relationId}`).getByTestId('relation-lifecycle-badge');
    await expect(endedBadge).toHaveText('Ended early');
    await expect(endedBadge).toHaveAttribute('title', 'Schedule conflict');
    await expect(page.getByTestId(`mentorship-row-${paused.relationId}`)).toHaveCount(0);

    // Turkish, and dark mode: the chip must not go dark-on-dark.
    await page.context().addCookies([
      { name: 'locale', value: 'tr', url: baseURL! },
      { name: 'theme', value: 'dark', url: baseURL! },
    ]);
    await gotoSettled(page, '/admin/mentorship');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByTestId('mentorship-filter-PAUSED').click();
    await expect(badge).toHaveText('Duraklatıldı');
    const colours = await badge.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fg: style.color, bg: style.backgroundColor };
    });
    expect(contrast(colours.fg, colours.bg)).toBeGreaterThanOrEqual(4.5);
  } finally {
    await cleanupMenteeWithRelation(paused);
    await cleanupMenteeWithRelation(ended);
    await cleanupByEmail(adminEmail);
  }
});
