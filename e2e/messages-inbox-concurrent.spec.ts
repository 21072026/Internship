import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Pressing "back" twice out of a thread rendered /messages twice at once, and
// each render upserted the project group rooms; the two writes deadlocked in
// InnoDB (P2034) and the inbox fell into the error boundary. Renders that race
// each other must all come back clean, and must not duplicate a room.
test('concurrent inbox renders do not deadlock on project group rooms', async ({ page }) => {
  const mentorEmail = uniqueEmail('inbox-race-mentor');
  const menteeEmail = uniqueEmail('inbox-race-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Race Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Race Mentee');
  const projects = await Promise.all([1, 2, 3].map((n) =>
    prisma.project.create({
      data: {
        name: `Inbox race ${n} ${Date.now()}`, ownerType: 'MENTOR', ownerUserId: mentor.id,
        members: { create: [{ userId: mentor.id, role: 'MENTOR' }, { userId: mentee.id, role: 'MENTEE' }] },
      },
    })
  ));
  const projectIds = projects.map((p) => p.id);

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    for (let round = 0; round < 3; round++) {
      const responses = await Promise.all(Array.from({ length: 6 }, () => page.request.get('/messages')));
      expect(responses.map((r) => r.status())).toEqual(Array(6).fill(200));
    }
    const rooms = await prisma.conversation.findMany({
      where: { type: 'GROUP', projectId: { in: projectIds } },
      select: { participants: { select: { userId: true } } },
    });
    expect(rooms).toHaveLength(3);
    for (const room of rooms) expect(room.participants).toHaveLength(2);
  } finally {
    await prisma.conversation.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
