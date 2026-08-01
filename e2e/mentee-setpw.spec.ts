import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';

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
    await signInAndSettle(page, mentorEmail, mentorPw, '/mentor');

    // Create a mentee WITH an email.
    await gotoSettled(page, '/mentor/mentees/new');
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
    // The mentor's session is still live, so this is a user switch: the helper
    // drops it without taking the seeded consent cookie with it.
    await signInAsFreshUser(page, menteeEmail, menteePw, '/portal');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
