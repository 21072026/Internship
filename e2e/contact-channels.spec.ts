import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('contacting a mentee can be logged as a Call/WhatsApp interaction', async ({ page }) => {
  const mentorEmail = uniqueEmail('cc-mentor');
  const menteeEmail = uniqueEmail('cc-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'CC Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'CC Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { phone: '+49 170 1234567', whatsapp: '+49 170 1234567' } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // The mentee detail page exposes Call / WhatsApp quick actions.
    await page.goto(`/mentor/mentees/${rel.id}`);
    await expect(page.getByRole('button', { name: /Call|Ara/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'WhatsApp' })).toBeVisible();

    // Logging a Call interaction (what the "reached them? yes" flow does) works
    // and a Call type is now accepted.
    const res = await page.request.post('/api/interactions', {
      data: { relationId: rel.id, date: new Date().toISOString(), type: 'Call', notes: 'Phone call' },
    });
    expect(res.status()).toBe(201);
    const logged = await prisma.interactionLog.findFirst({ where: { relationId: rel.id, type: 'Call' } });
    expect(logged).toBeTruthy();
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
