import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('adding a mentee with an email yields a set-password link the mentee can use to sign in', async ({
  page,
}) => {
  const mentorEmail = uniqueEmail('setpw-mentor');
  const menteeEmail = uniqueEmail('setpw-mentee');
  const mentorPw = 'MentorPass123!';
  const menteePw = 'MenteeChosen456!';
  await seedUser(mentorEmail, mentorPw, 'MENTOR', 'SetPw Mentor');

  try {
    // Sign in as the mentor.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', mentorPw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Create a mentee WITH an email.
    await page.goto('/mentor/mentees/new');
    await page.getByLabel(/Full Name/).fill('New Mentee Person');
    await page.getByLabel(/Email/).fill(menteeEmail);
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/mentor/mentees') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    await created;

    // The set-password link is shown; grab it.
    await expect(page.getByText('Mentee created')).toBeVisible({ timeout: 10_000 });
    const link = await page.locator('input[readonly]').inputValue();
    expect(link).toContain('/auth/reset?token=');
    const token = new URL(link).searchParams.get('token')!;
    expect(token).toBeTruthy();

    // Mentee follows the link and chooses a password.
    await page.goto(`/auth/reset?token=${token}`);
    await page.getByLabel(/New password/).fill(menteePw);
    await page.getByLabel(/Confirm Password/i).fill(menteePw);
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/auth/reset') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Update password/ }).click();
    await done;
    await page.waitForURL((u) => u.pathname.startsWith('/auth/signin'), { timeout: 20_000 });

    // Mentee can now sign in with their chosen password → lands on the portal.
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', menteePw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
