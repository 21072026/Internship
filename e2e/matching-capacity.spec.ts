import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor can set expertise/capacity from account settings (round-trips)', async ({ page }) => {
  const mentorEmail = uniqueEmail('mc-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MC Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const put = await page.request.put('/api/profile', { data: { skills: ['React', 'TypeScript'], mentorCapacity: 5 } });
    expect(put.ok()).toBeTruthy();
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.mentorCapacity).toBe(5);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
