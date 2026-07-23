import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('meeting series auto-generates project-member meetings, stays idempotent, and stops after cancel', async ({ page }) => {
  const mentorEmail = uniqueEmail('ms-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Series Mentor');
  const mentee = await seedUser(uniqueEmail('ms-mentee'), 'x', 'MENTEE', 'Series Mentee');

  const project = await prisma.project.create({
    data: {
      name: `Series Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE' },
        ],
      },
    },
  });

  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, projectId: project.id },
  });

  const targetDow = (new Date().getUTCDay() + 1) % 7;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const createRes = await page.request.post('/api/meeting-series', {
      data: {
        projectId: project.id,
        title: 'Weekly project sync',
        daysOfWeek: [targetDow],
        timeOfDay: '12:00',
        weeksAhead: 2,
        meetLink: '',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.createdMeetings).toBe(2);
    expect(created.series?.id).toBeTruthy();

    const seriesId = created.series.id as string;
    const generated = await prisma.meeting.findMany({
      where: { seriesId, relationId: rel.id },
      orderBy: { scheduledAt: 'asc' },
    });
    expect(generated).toHaveLength(2);
    expect(new Set(generated.map((m) => m.meetLink)).size).toBe(1);
    expect(generated[0]?.meetLink).toContain('meet.jit.si');

    const rerunRes = await page.request.put('/api/meeting-series', {
      data: { id: seriesId, weeksAhead: 2 },
    });
    expect(rerunRes.ok()).toBeTruthy();
    const rerun = await rerunRes.json();
    expect(rerun.createdMeetings).toBe(0);

    const cancelRes = await page.request.delete('/api/meeting-series', {
      data: { id: seriesId },
    });
    expect(cancelRes.ok()).toBeTruthy();

    const afterCancelRes = await page.request.put('/api/meeting-series', {
      data: { id: seriesId, title: 'Weekly project sync (cancelled)', weeksAhead: 2 },
    });
    expect(afterCancelRes.ok()).toBeTruthy();
    const afterCancel = await afterCancelRes.json();
    expect(afterCancel.series?.active).toBe(false);
    expect(afterCancel.createdMeetings).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.meetingSeries.deleteMany({ where: { projectId: project.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});
