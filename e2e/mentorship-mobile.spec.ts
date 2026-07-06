import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Regression: on a phone viewport the mentorship row must stack, so the company
// picker and "Mark complete" control stay within the screen instead of bleeding
// off the right edge.
test('mentorship rows do not overflow the viewport on mobile', async ({ page }) => {
  const W = 390;
  const adminEmail = uniqueEmail('mm-admin');
  const mentorEmail = uniqueEmail('mm-mentor');
  const menteeEmail = uniqueEmail('mm-mentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'MM Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'MM Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'MM Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await page.setViewportSize({ width: W, height: 820 });
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/mentorship');
    const row = page.getByTestId(`mentorship-row-${rel.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The "Mark complete" button sits fully within the viewport width (would be
    // clipped off the right edge with the old non-wrapping row layout).
    const btn = row.getByRole('button', { name: /Mark complete|Tamamland|Abgeschlossen/i });
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(W + 1);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
