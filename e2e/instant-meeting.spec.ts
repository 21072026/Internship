import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1053 / #1054 — starting a call from where the person already is: one click,
// one question (the topic), then the room is on screen.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee card starts a meeting in one click and opens the side panel', { tag: '@smoke' }, async ({ page }) => {
  const mentorEmail = uniqueEmail('inst-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Instant Mentor');
  const mentee = await seedUser(uniqueEmail('inst-mentee'), 'x', 'MENTEE', 'Instant Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/mentees');

    // The card's own button, not any other "start meeting" on the page.
    await page.getByTestId(`start-meeting-${rel.id}`).click();

    // Only the topic is asked for, and it is pre-filled with the mentee's name.
    const topic = page.getByTestId('instant-meeting-topic');
    await expect(topic).toBeVisible();
    await expect(topic).toHaveValue(/Instant Mentee/);

    await topic.fill('Quick sync');
    await page.getByTestId('instant-meeting-confirm').click();

    // The room is on screen without a list refresh.
    await expect(page.getByTestId('meeting-side-panel')).toBeVisible({ timeout: 15_000 });

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting?.title).toBe('Quick sync');
    expect(meeting?.meetLink).toContain('meet.jit.si');
    // A time-less room: no RSVP chasing, no reminder mail.
    expect(meeting?.scheduledAt).toBeNull();

    // The panel outlives navigation — a call must not drop when the mentor
    // walks over to the mentee's profile.
    await page.goto('/mentor');
    await expect(page.getByTestId('meeting-side-panel')).toBeVisible();

    await page.getByTestId('meeting-side-panel-close').click();
    await expect(page.getByTestId('meeting-side-panel')).toBeHidden();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('the instant endpoint returns the room link in the response', async ({ page }) => {
  const mentorEmail = uniqueEmail('inst-api-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Instant API Mentor');
  const mentee = await seedUser(uniqueEmail('inst-api-mentee'), 'x', 'MENTEE', 'Instant API Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/meetings/instant', {
      data: { relationIds: [rel.id], title: 'Now' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    // The whole point of the endpoint: no follow-up fetch to learn the link.
    expect(body.meetLink).toContain('meet.jit.si');
    expect(body.meetingId).toBeTruthy();
    expect(body.invited).toBe(1);

    // Exactly one context, always: a relation meeting carries no project/chat.
    const meeting = await prisma.meeting.findUnique({ where: { id: body.meetingId } });
    expect(meeting?.relationId).toBe(rel.id);
    expect(meeting?.projectId).toBeNull();
    expect(meeting?.conversationId).toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test("a mentor cannot start a meeting for someone else's mentee", async ({ page }) => {
  const outsiderEmail = uniqueEmail('inst-outsider');
  const outsider = await seedUser(outsiderEmail, 'MentorPass123', 'MENTOR', 'Instant Outsider');
  const owner = await seedUser(uniqueEmail('inst-owner'), 'x', 'MENTOR', 'Instant Owner');
  const mentee = await seedUser(uniqueEmail('inst-victim'), 'x', 'MENTEE', 'Instant Victim');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: owner.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, outsiderEmail, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/meetings/instant', {
      data: { relationIds: [rel.id], title: 'Not mine' },
    });
    expect(res.status()).toBe(404);
    expect(await prisma.meeting.count({ where: { relationId: rel.id } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(owner.email);
    await cleanupByEmail(outsiderEmail);
  }
});
