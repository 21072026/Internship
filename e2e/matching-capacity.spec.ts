import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string, home: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('suggestions flag at-capacity mentors and a mentor can set expertise/capacity', async ({ page }) => {
  const adminEmail = uniqueEmail('mc-admin');
  const mentorEmail = uniqueEmail('mc-mentor');
  const fullEmail = uniqueEmail('mc-full');
  const menteeEmail = uniqueEmail('mc-mentee');
  const otherEmail = uniqueEmail('mc-other');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'MC Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MC Mentor');
  const full = await seedUser(fullEmail, 'x', 'MENTOR', 'MC Full');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'MC Mentee');
  const other = await seedUser(otherEmail, 'x', 'MENTEE', 'MC Other');

  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['React', 'Python'] } });
  await prisma.user.update({ where: { id: mentor.id }, data: { skills: ['React', 'Node'] } });
  await prisma.user.update({ where: { id: full.id }, data: { skills: ['React'], mentorCapacity: 1 } });
  const occ = await prisma.mentorshipRelation.create({ data: { mentorId: full.id, menteeId: other.id, status: 'ACTIVE' } });

  try {
    await signIn(page, adminEmail, 'AdminPass123', '/admin');
    const res = await (await page.request.get(`/api/admin/suggest-mentors?menteeId=${mentee.id}`)).json();
    const sMentor = res.suggestions.find((s: { id: string }) => s.id === mentor.id);
    const sFull = res.suggestions.find((s: { id: string }) => s.id === full.id);
    expect(sMentor.overlap).toBeGreaterThanOrEqual(1);
    expect(sFull.atCapacity).toBe(true);

    // A mentor sets expertise + capacity from account settings (round-trips).
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const put = await page.request.put('/api/profile', { data: { skills: ['React', 'TypeScript'], mentorCapacity: 5 } });
    expect(put.ok()).toBeTruthy();
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.mentorCapacity).toBe(5);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: occ.id } });
    await cleanupByEmail(otherEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(fullEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
