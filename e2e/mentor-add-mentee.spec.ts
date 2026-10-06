import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor can add a mentee and it is assigned to them', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const password = 'MentorPass123!';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'AddMentee Mentor');
  const menteeName = `ZZ Added Mentee ${Date.now()}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/mentees/new');
    await page.getByLabel(/Full Name/).fill(menteeName);
    await page.getByLabel(/City/).fill('Köln');
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/mentor/mentees') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    await created;
    await page.waitForURL((u) => u.pathname.endsWith('/mentor/mentees'), { timeout: 15_000 });

    // Persisted: a MENTEE owned by this mentor
    const mentee = await prisma.user.findFirst({ where: { fullName: menteeName, role: 'MENTEE' } });
    expect(mentee).not.toBeNull();
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee!.id },
    });
    expect(rel).not.toBeNull();

    await expect(page.getByText(menteeName)).toBeVisible();
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee!.id } });
    await prisma.user.delete({ where: { id: mentee!.id } }).catch(() => {});
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
