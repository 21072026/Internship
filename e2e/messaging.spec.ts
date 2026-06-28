import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('mentor email lands in the thread and notifies the mentee', async ({ page }) => {
  const mentorEmail = uniqueEmail('msg-mentor');
  const menteeEmail = uniqueEmail('msg-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Msg Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Msg Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/mentor/email', {
      data: { relationIds: [rel.id], subject: 'Welcome', body: 'Glad to mentor you.' },
    });
    expect(res.ok()).toBeTruthy();

    await expect.poll(async () =>
      prisma.message.count({ where: { relationId: rel.id, channel: 'EMAIL' } })
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      prisma.notification.count({ where: { userId: mentee.id, type: 'message' } })
    ).toBeGreaterThan(0);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentee can reply in the thread and the mentor is notified', async ({ page }) => {
  const mentorEmail = uniqueEmail('rep-mentor');
  const menteeEmail = uniqueEmail('rep-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Rep Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Rep Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.message.create({ data: { relationId: rel.id, senderId: mentor.id, channel: 'EMAIL', body: 'How is it going?' } });

  try {
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto(`/messages/${rel.id}`);
    await expect(page.getByText('How is it going?')).toBeVisible({ timeout: 10_000 });

    await page.locator('textarea').fill('Going great, thanks!');
    const done = page.waitForResponse((r) => r.url().includes('/api/messages') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send' }).click();
    await done;

    await expect.poll(async () =>
      prisma.message.count({ where: { relationId: rel.id, senderId: mentee.id } })
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      prisma.notification.count({ where: { userId: mentor.id, type: 'message' } })
    ).toBeGreaterThan(0);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
