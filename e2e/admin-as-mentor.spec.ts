import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an admin can be assigned as a mentee\'s mentor', async ({ page }) => {
  const adminEmail = uniqueEmail('aam-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'AAM Admin');
  const mentee = await seedUser(uniqueEmail('aam-mentee'), 'x', 'MENTEE', 'AAM Mentee');
  let relId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Assigning an ADMIN as the mentor succeeds (admins can mentor).
    const res = await page.request.post('/api/mentorship', { data: { mentorId: admin.id, menteeId: mentee.id } });
    expect(res.status()).toBe(201);
    relId = (await res.json()).relation.id;

    // The mentorship assign form lists the admin as a selectable mentor.
    await page.goto('/admin/mentorship');
    const data = await (await page.request.get('/api/users')).json();
    expect(data.users.some((u: { id: string; role: string }) => u.id === admin.id && u.role === 'ADMIN')).toBeTruthy();
  } finally {
    if (relId) await prisma.mentorshipRelation.deleteMany({ where: { id: relId } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(adminEmail);
  }
});
