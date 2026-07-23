import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('scheduling a meeting without a link auto-generates a video room link', async ({ page }) => {
  const mentorEmail = uniqueEmail('aml-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'AML Mentor');
  const mentee = await seedUser(uniqueEmail('aml-mentee'), 'x', 'MENTEE', 'AML Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Intro call', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting?.meetLink).toBeTruthy();
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

// #759 — a bulk-scheduled meeting is ONE shared meeting: every selected mentee
// must get the SAME auto-generated link (not a separate room each), while the
// per-person RSVP token stays unique.
test('bulk scheduling without a link shares one meeting link across all selected mentees', async ({ page }) => {
  const mentorEmail = uniqueEmail('bulk-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bulk Mentor');
  const mentees = await Promise.all([
    seedUser(uniqueEmail('bulk-m1'), 'x', 'MENTEE', 'Bulk M1'),
    seedUser(uniqueEmail('bulk-m2'), 'x', 'MENTEE', 'Bulk M2'),
    seedUser(uniqueEmail('bulk-m3'), 'x', 'MENTEE', 'Bulk M3'),
  ]);
  const rels = await Promise.all(
    mentees.map((m) => prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m.id } })),
  );
  const relIds = rels.map((r) => r.id);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/meetings', {
      data: { relationIds: relIds, title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).created).toBe(relIds.length);

    const meetings = await prisma.meeting.findMany({ where: { relationId: { in: relIds } } });
    expect(meetings).toHaveLength(relIds.length);

    // All share exactly one auto-generated link…
    const links = new Set(meetings.map((m) => m.meetLink));
    expect(links.size).toBe(1);
    expect([...links][0]).toContain('meet.jit.si');

    // …but each participant's RSVP token is unique.
    const tokens = new Set(meetings.map((m) => m.rsvpToken));
    expect(tokens.size).toBe(relIds.length);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: { in: relIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relIds } } });
    await Promise.all(mentees.map((m) => cleanupByEmail(m.email)));
    await cleanupByEmail(mentorEmail);
  }
});
