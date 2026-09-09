import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1055 — the same one-click call, but for a whole project team or a group chat.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a project owner starts a meeting for the whole team', async ({ page }) => {
  const ownerEmail = uniqueEmail('pm-owner');
  const owner = await seedUser(ownerEmail, 'MentorPass123', 'MENTOR', 'PM Owner');
  const member = await seedUser(uniqueEmail('pm-member'), 'x', 'MENTEE', 'PM Member');
  const project = await prisma.project.create({
    data: {
      name: 'Instant Team Project',
      ownerType: 'MENTOR',
      ownerUserId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: member.id, role: 'MENTEE' },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, ownerEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/meetings/instant', {
      data: { projectId: project.id, title: 'Standup' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.meetLink).toContain('meet.jit.si');
    // Everyone but the organizer.
    expect(body.invited).toBe(1);

    const meeting = await prisma.meeting.findUnique({ where: { id: body.meetingId } });
    expect(meeting?.projectId).toBe(project.id);
    expect(meeting?.relationId).toBeNull();
    expect(meeting?.conversationId).toBeNull();

    // The member hears about it in the app, not only by email.
    const note = await prisma.notification.findFirst({
      where: { userId: member.id, type: 'meeting.started' },
    });
    expect(note?.link).toBe(body.meetLink);
  } finally {
    await prisma.meeting.deleteMany({ where: { projectId: project.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [owner.id, member.id] } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(member.email);
    await cleanupByEmail(ownerEmail);
  }
});

test('a mentee member cannot summon the whole project', async ({ page }) => {
  const menteeEmail = uniqueEmail('pm-mentee');
  const owner = await seedUser(uniqueEmail('pm-owner2'), 'x', 'MENTOR', 'PM Owner2');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'PM Mentee');
  const project = await prisma.project.create({
    data: {
      name: 'Instant Team Project 2',
      ownerType: 'MENTOR',
      ownerUserId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE' },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');

    const res = await page.request.post('/api/meetings/instant', {
      data: { projectId: project.id, title: 'Nope' },
    });
    expect(res.status()).toBe(403);
    expect(await prisma.meeting.count({ where: { projectId: project.id } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(owner.email);
  }
});

test('a meeting started from a group chat drops its link into that chat', async ({ page }) => {
  const starterEmail = uniqueEmail('gc-starter');
  const starter = await seedUser(starterEmail, 'MentorPass123', 'MENTOR', 'GC Starter');
  const other = await seedUser(uniqueEmail('gc-other'), 'x', 'MENTEE', 'GC Other');
  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      participants: { create: [{ userId: starter.id }, { userId: other.id }] },
    },
  });

  try {
    await signInAndSettle(page, starterEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/meetings/instant', {
      data: { conversationId: conversation.id, title: 'Huddle' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();

    const meeting = await prisma.meeting.findUnique({ where: { id: body.meetingId } });
    expect(meeting?.conversationId).toBe(conversation.id);
    expect(meeting?.projectId).toBeNull();

    // The people already reading the thread shouldn't have to dig the link out
    // of a notification.
    const message = await prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(message?.body).toContain(body.meetLink);
    expect(message?.senderId).toBe(starter.id);
  } finally {
    await prisma.meeting.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [starter.id, other.id] } } });
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await cleanupByEmail(other.email);
    await cleanupByEmail(starterEmail);
  }
});

// #2011 — the honest half. CI runs with no JAAS_* credentials, so every room
// the server hands out here is a public meet.jit.si room, which is exactly the
// case that used to fail silently: the panel opened, the standup ran, and five
// minutes later the embedded call hung up on everyone with no warning at any
// point. The warning must be on screen BEFORE anyone joins.
test('a group call on the free room says so before anyone joins', async ({ page }) => {
  const starterEmail = uniqueEmail('warn-starter');
  const starter = await seedUser(starterEmail, 'MentorPass123', 'MENTOR', 'Warn Starter');
  const one = await seedUser(uniqueEmail('warn-one'), 'x', 'MENTEE', 'Warn One');
  const two = await seedUser(uniqueEmail('warn-two'), 'x', 'MENTEE', 'Warn Two');
  // Three people, so the room is a group room and not a pair.
  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      participants: { create: [{ userId: starter.id }, { userId: one.id }, { userId: two.id }] },
    },
  });

  try {
    await signInAndSettle(page, starterEmail, 'MentorPass123', '/mentor');
    await page.goto(`/messages/c/${conversation.id}`);

    // The thread header renders a desktop and a mobile start button, so take
    // the one this viewport actually shows rather than the first in the DOM.
    await page.locator('[data-testid="start-meeting-conversation"]:visible').click();
    await page.getByTestId('instant-meeting-topic').fill('Standup');
    await page.getByTestId('instant-meeting-confirm').click();

    await expect(page.getByTestId('meeting-side-panel')).toBeVisible({ timeout: 15_000 });
    const warning = page.locator('[data-testid="meeting-free-room-warning"]:visible');
    await expect(warning).toBeVisible();
    // Not just a shrug: the escape from the cutoff is the same room in a tab,
    // and the button for it is inside the warning.
    await expect(warning.locator('[data-testid="meeting-free-room-warning-open"]')).toHaveAttribute(
      'href',
      /^https:\/\/meet\.jit\.si\//
    );

    const meeting = await prisma.meeting.findFirst({ where: { conversationId: conversation.id } });
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await prisma.meeting.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [starter.id, one.id, two.id] } } });
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await cleanupByEmail(two.email);
    await cleanupByEmail(one.email);
    await cleanupByEmail(starterEmail);
  }
});

test('someone outside the chat cannot start a meeting in it', async ({ page }) => {
  const outsiderEmail = uniqueEmail('gc-outsider');
  const outsider = await seedUser(outsiderEmail, 'MentorPass123', 'MENTOR', 'GC Outsider');
  const a = await seedUser(uniqueEmail('gc-a'), 'x', 'MENTOR', 'GC A');
  const b = await seedUser(uniqueEmail('gc-b'), 'x', 'MENTEE', 'GC B');
  const conversation = await prisma.conversation.create({
    data: { type: 'GROUP', participants: { create: [{ userId: a.id }, { userId: b.id }] } },
  });

  try {
    await signInAndSettle(page, outsiderEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/meetings/instant', {
      data: { conversationId: conversation.id, title: 'Intruder' },
    });
    expect(res.status()).toBe(403);
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await cleanupByEmail(b.email);
    await cleanupByEmail(a.email);
    await cleanupByEmail(outsiderEmail);
  }
});
