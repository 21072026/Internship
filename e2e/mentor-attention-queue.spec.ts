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

// #2275: "contact" is not "a row in InteractionLog". A mentor exchanging
// messages with a mentee in the app has been in touch, and the queue used to
// say otherwise — which is what made an eleven-row queue meaningless. The two
// edges worth an e2e run are the group-chat ones, because they pull in opposite
// directions: somebody else's group message must NOT clear the flag, the
// mentee's own group message must.
test('in-app messages count as contact — 1:1 either way, group only when the mentee wrote it', async ({ page }) => {
  const mentorEmail = uniqueEmail('contact-mentor');
  const dmEmail = uniqueEmail('contact-dm-mentee');
  const groupOtherEmail = uniqueEmail('contact-group-other');
  const groupSelfEmail = uniqueEmail('contact-group-self');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Contact Mentor');
  const dmMentee = await seedUser(dmEmail, 'x', 'MENTEE', 'Direct Message Mentee');
  const groupOtherMentee = await seedUser(groupOtherEmail, 'x', 'MENTEE', 'Group Silent Mentee');
  const groupSelfMentee = await seedUser(groupSelfEmail, 'x', 'MENTEE', 'Group Poster Mentee');

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const relationFor = async (menteeId: string) => {
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId, status: 'ACTIVE' },
    });
    // An open goal on every one of them, so "no open goal" cannot be the reason
    // a row shows up and the assertions below are about contact only.
    await prisma.goal.create({ data: { relationId: relation.id, title: 'Finish portfolio site' } });
    return relation;
  };

  const dmRel = await relationFor(dmMentee.id);
  const groupOtherRel = await relationFor(groupOtherMentee.id);
  const groupSelfRel = await relationFor(groupSelfMentee.id);

  // The mentorship's 1:1 thread, written by the MENTOR — the direction that was
  // broken: reaching out is not the same as logging that you reached out.
  const dmConversation = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      directKey: [mentor.id, dmMentee.id].sort().join('|'),
      participants: { create: [{ userId: mentor.id }, { userId: dmMentee.id }] },
    },
  });
  await prisma.message.create({
    data: {
      conversationId: dmConversation.id,
      relationId: dmRel.id,
      senderId: mentor.id,
      body: 'Sent you the interview prep list — have a look before Friday.',
      createdAt: twoDaysAgo,
    },
  });

  // One group chat holding both group mentees. The MENTOR posts in it: a
  // broadcast, so it is contact with neither of them.
  const groupConversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      participants: {
        create: [{ userId: mentor.id }, { userId: groupOtherMentee.id }, { userId: groupSelfMentee.id }],
      },
    },
  });
  await prisma.message.create({
    data: {
      conversationId: groupConversation.id,
      senderId: mentor.id,
      body: 'Reminder for everyone: the cohort demo is next Tuesday.',
      createdAt: twoDaysAgo,
    },
  });
  // …and one of them answers in the same group. That is a sign of life.
  await prisma.message.create({
    data: {
      conversationId: groupConversation.id,
      senderId: groupSelfMentee.id,
      body: 'Noted, I will be there.',
      createdAt: twoDaysAgo,
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const queue = page.getByTestId('attention-queue');
    // The group mentee who never wrote is the only one of the three still
    // flagged — which also proves the queue rendered at all, so the two
    // absence assertions below are not vacuously true.
    const silentRow = queue.getByRole('link', { name: /Group Silent Mentee/ });
    await expect(silentRow).toBeVisible({ timeout: 10_000 });
    await expect(silentRow.getByText(/No recent contact/i)).toBeVisible();

    // A 1:1 message from the mentor is contact: nothing left to flag.
    await expect(queue.getByText('Direct Message Mentee', { exact: true })).toHaveCount(0);
    // The mentee's own group post is contact too.
    await expect(queue.getByText('Group Poster Mentee', { exact: true })).toHaveCount(0);
  } finally {
    const relationIds = [dmRel.id, groupOtherRel.id, groupSelfRel.id];
    await prisma.message.deleteMany({
      where: { conversationId: { in: [dmConversation.id, groupConversation.id] } },
    });
    await prisma.goal.deleteMany({ where: { relationId: { in: relationIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relationIds } } });
    await prisma.conversation.deleteMany({
      where: { id: { in: [dmConversation.id, groupConversation.id] } },
    });
    await cleanupByEmail(dmEmail);
    await cleanupByEmail(groupOtherEmail);
    await cleanupByEmail(groupSelfEmail);
    await cleanupByEmail(mentorEmail);
  }
});
