import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee portal shows a quick message-mentor action and the "Mentörüm" label (TR)', async ({ page }) => {
  const mentorEmail = uniqueEmail('pqc-mentor');
  const menteeEmail = uniqueEmail('pqc-mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'PQC Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'PQC Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Quick "message mentor" action links straight to the thread.
    await page.goto('/portal');
    const msgLink = page.getByRole('link', { name: /Message|Mesaj/i }).first();
    await expect(msgLink).toHaveAttribute('href', `/messages/${rel.id}`, { timeout: 10_000 });

    // Turkish label reads "Mentörüm" (not the awkward "Mentorun").
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.reload();
    await expect(page.getByText('Mentörüm').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
