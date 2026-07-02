import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor dashboard surfaces a needs-attention queue for stale/overdue/unanswered mentees', async ({ page }) => {
  const mentorEmail = uniqueEmail('attn-mentor');
  const menteeEmail = uniqueEmail('attn-mentee');
  const okMenteeEmail = uniqueEmail('attn-ok-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Attention Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Needs Attention Mentee');
  const okMentee = await seedUser(okMenteeEmail, 'x', 'MENTEE', 'Fine Mentee');

  // Overdue stage deadline + unanswered question + pending meeting request, no interactions logged.
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      stageDeadline: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.mentorQuestion.create({
    data: { relationId: rel.id, askedById: mentee.id, question: 'What should I prepare for the interview?' },
  });
  await prisma.meetingRequest.create({
    data: { relationId: rel.id, requestedById: mentee.id, topic: 'Check-in', proposedAt: new Date(Date.now() + 86_400_000) },
  });

  // A fine relation with a recent interaction and nothing pending — should NOT appear.
  const okRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: okMentee.id, status: 'ACTIVE' } });
  await prisma.interactionLog.create({
    data: { relationId: okRel.id, type: 'Meeting', notes: 'Recent sync', date: new Date() },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const queue = page.getByTestId('attention-queue');
    await expect(queue.getByRole('heading', { name: /Needs attention/i })).toBeVisible({ timeout: 10_000 });
    const row = queue.getByRole('link', { name: /Needs Attention Mentee/ });
    await expect(row).toBeVisible();
    await expect(row.getByText(/No recent contact/i)).toBeVisible();
    await expect(row.getByText(/Stage overdue/i)).toBeVisible();
    await expect(row.getByText(/Unanswered question/i)).toBeVisible();
    await expect(row.getByText(/Pending meeting request/i)).toBeVisible();

    // The healthy relation is not in the attention queue (it may still
    // legitimately appear elsewhere on the dashboard, e.g. "My mentees").
    await expect(queue.getByText('Fine Mentee')).toHaveCount(0);
  } finally {
    await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorQuestion.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [rel.id, okRel.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(okMenteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
