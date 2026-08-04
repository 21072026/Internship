import { test, expect } from '@playwright/test';
import { cleanupByEmail, prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('candidates are usable without horizontal overflow on mobile and keep the desktop list', async ({ page }) => {
  const adminEmail = uniqueEmail('candidates-mobile-admin');
  const mentorEmail = uniqueEmail('candidates-mobile-mentor');
  const menteeEmail = uniqueEmail('candidates-mobile-mentee');
  const password = 'AdminPass123';
  await seedUser(adminEmail, password, 'ADMIN', 'Mobile Candidates Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Mobile Candidate Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Mobile Candidate Name That Wraps Safely');

  await prisma.user.update({
    where: { id: mentee.id },
    data: {
      university: 'Mobile Test University With A Long Name',
      department: 'Computer Science',
      graduationYear: 2027,
      city: 'A Long Mobile Test City',
      skills: ['TypeScript', 'Responsive interface design'],
    },
  });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAndSettle(page, adminEmail, password, '/admin');
    await page.goto('/admin/candidates');

    const search = page.getByTestId('candidates-search-input');
    await page.getByTestId('candidates-mobile-filter-toggle').click();
    await expect(search).toBeVisible();
    await search.fill(menteeEmail);

    const mobileList = page.getByTestId('candidates-mobile-list');
    const mobileCard = page.getByTestId(`candidate-mobile-card-${mentee.id}`);
    await expect(mobileList).toBeVisible({ timeout: 10_000 });
    await expect(mobileCard).toBeVisible();
    await expect(mobileCard.getByText(mentee.fullName)).toBeVisible();
    await expect(mobileCard.getByTestId('candidate-mobile-stage')).toBeVisible();
    await expect(mobileCard.getByText(/Mobile Candidate Mentor/)).toBeVisible();

    for (const testId of [
      'candidates-search-input',
      'candidates-skill-filter',
      'candidates-year-filter',
      'candidates-city-filter',
      'candidates-project-filter',
      'candidates-source-filter',
      'candidates-stage-filter',
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    const hasHorizontalOverflow = await page.evaluate(() => {
      const element = document.scrollingElement;
      if (!element) return true;
      return element.scrollWidth > element.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('candidates-desktop-list')).toBeVisible();
    await expect(mobileList).toBeHidden();
    await expect(page.getByTestId(`candidate-card-${mentee.id}`)).toBeVisible();
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
