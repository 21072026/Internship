import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC A (#414): admins can set a mentor's expertise, and skill-match then
// produces a real (non-zero) overlap — regression against "all mentors show
// 0 matching skills" because mentors had no skills.
test('admin sets mentor expertise and skill-match returns a real overlap', async ({ page }) => {
  const mentorEmail = uniqueEmail('sm-mentor');
  const menteeEmail = uniqueEmail('sm-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'SM Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'SM Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Kotlin', 'AWS', 'Java'] } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Before: mentor has no expertise → zero overlap.
    const before = await (await page.request.get(`/api/admin/suggest-mentors?menteeId=${mentee.id}`)).json();
    const b = before.suggestions.find((s: { id: string }) => s.id === mentor.id);
    expect(b.overlap).toBe(0);

    // Admin sets the mentor's expertise + capacity via the users endpoint.
    const patch = await page.request.patch(`/api/users/${mentor.id}`, {
      data: { skills: ['Kotlin', 'AWS', 'Go'], mentorCapacity: 5 },
    });
    expect(patch.ok()).toBeTruthy();

    // After: overlap reflects the real intersection (Kotlin + AWS = 2).
    const after = await (await page.request.get(`/api/admin/suggest-mentors?menteeId=${mentee.id}`)).json();
    const a = after.suggestions.find((s: { id: string }) => s.id === mentor.id);
    expect(a.overlap).toBe(2);
    expect(a.capacity).toBe(5);

    // The mentors list shows the expertise chips.
    await page.goto('/admin/mentors');
    // Target the mentors search box (the admin layout also has a "Filter menu" one).
    await page.getByPlaceholder(/name, email or skill/i).fill('SM Mentor');
    await expect(page.getByText('Kotlin', { exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
