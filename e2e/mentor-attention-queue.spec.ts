import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor dashboard surfaces a needs-attention queue for stale/overdue/unanswered mentees', async ({ page }) => {
  const mentorEmail = uniqueEmail('attn-mentor');
  const menteeEmail = uniqueEmail('attn-mentee');
  const okMenteeEmail = uniqueEmail('attn-ok-mentee');
  const todoMenteeEmail = uniqueEmail('attn-todo-mentee');
  const selfTodoMenteeEmail = uniqueEmail('attn-self-todo-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Attention Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Needs Attention Mentee');
  const okMentee = await seedUser(okMenteeEmail, 'x', 'MENTEE', 'Fine Mentee');
  const todoMentee = await seedUser(todoMenteeEmail, 'x', 'MENTEE', 'Todo Mentee');
  const selfTodoMentee = await seedUser(selfTodoMenteeEmail, 'x', 'MENTEE', 'Self Todo Mentee');

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

  // A fine relation with a recent interaction, an open goal, and nothing
  // pending — should NOT appear. (An open goal is required so it doesn't trip
  // the no_open_goal signal.)
  const okRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: okMentee.id, status: 'ACTIVE' } });
  await prisma.interactionLog.create({
    data: { relationId: okRel.id, type: 'Meeting', notes: 'Recent sync', date: new Date() },
  });
  await prisma.goal.create({ data: { relationId: okRel.id, title: 'Finish portfolio site' } });

  // Same shape, but the open work is a to-do the mentor handed out (a
  // ProjectTask) instead of a Goal row — which is how the shared pool works.
  // It must count as open work, so this relation stays out of the queue too.
  const todoRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: todoMentee.id, status: 'ACTIVE' } });
  await prisma.interactionLog.create({
    data: { relationId: todoRel.id, type: 'Meeting', notes: 'Recent sync', date: new Date() },
  });
  const todo = await prisma.projectTask.create({
    data: { title: 'Update your CV', assigneeId: todoMentee.id, createdById: mentor.id },
  });

  // A line the mentee wrote for themselves is private — the mentor can't see it
  // on the list, so it must not silently clear the flag either.
  const selfTodoRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: selfTodoMentee.id, status: 'ACTIVE' } });
  await prisma.interactionLog.create({
    data: { relationId: selfTodoRel.id, type: 'Meeting', notes: 'Recent sync', date: new Date() },
  });
  const selfTodo = await prisma.projectTask.create({
    data: { title: 'Read a chapter', assigneeId: selfTodoMentee.id, createdById: selfTodoMentee.id },
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
    // This mentee has no goals yet → the no_open_goal signal shows too (#572).
    await expect(row.getByText(/No open goal/i)).toBeVisible();

    // The healthy relation is not in the attention queue (it may still
    // legitimately appear elsewhere on the dashboard, e.g. "My mentees").
    await expect(queue.getByText('Fine Mentee')).toHaveCount(0);
    // An open to-do is open work: no "no open goal" flag, so nothing left to
    // put this relation in the queue.
    await expect(queue.getByText('Todo Mentee', { exact: true })).toHaveCount(0);
    // …but a private, self-written to-do is not visible open work to the mentor.
    const selfRow = queue.getByRole('link', { name: /Self Todo Mentee/ });
    await expect(selfRow.getByText(/No open goal/i)).toBeVisible();
  } finally {
    await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorQuestion.deleteMany({ where: { relationId: rel.id } });
    await prisma.projectTask.deleteMany({ where: { id: { in: [todo.id, selfTodo.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [rel.id, okRel.id, todoRel.id, selfTodoRel.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(okMenteeEmail);
    await cleanupByEmail(todoMenteeEmail);
    await cleanupByEmail(selfTodoMenteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
