// Notification caps are a promise to a PERSON, and they must survive a
// duplicate (#2287).
//
// WHY THIS TEST HAS TO SEED AROUND THE GUARDS
//   Every cap here used to be counted on the RELATION. While "one mentee, at
//   most one ACTIVE mentor" (#419) holds, per relation and per person are the
//   same number, so nothing observable differs — which means the only way to
//   test the cap is to create the state the invariant forbids, directly through
//   Prisma, bypassing `activeMentorship.ts`. That seeding step IS the test: a
//   spec that goes through the normal write paths cannot reach this at all.
//
//   That is also why this is worth having even though #2283 closed the write
//   paths and #2286 will add the DB backstop: #1797/#1799 propose raising the
//   limit above one DELIBERATELY, and on that day these caps are load-bearing
//   rather than defensive.
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { sweepDormantFirstContacts } from '../src/lib/dormantFirstContact';
import { sendDormantCheckIns, sendWeeklyReportReminders, DORMANT_MAX_NUDGES } from '../src/services/emailService';

test.afterAll(async () => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

test('two ACTIVE relations spend ONE dormant budget, not two', async () => {
  const menteeEmail = uniqueEmail('caps-dormant-mentee');
  const mentorAEmail = uniqueEmail('caps-dormant-mentor-a');
  const mentorBEmail = uniqueEmail('caps-dormant-mentor-b');
  try {
    const mentee = await seedUser(menteeEmail, 'CapsPass123', 'MENTEE', 'Doubly Mentored');
    const mentorA = await seedUser(mentorAEmail, 'CapsPass123', 'MENTOR', 'Caps Mentor A');
    const mentorB = await seedUser(mentorBEmail, 'CapsPass123', 'MENTOR', 'Caps Mentor B');

    // The state the invariant forbids, written straight to the database.
    const relations: { id: string }[] = [];
    for (const mentor of [mentorA, mentorB]) {
      const relation = await prisma.mentorshipRelation.create({
        data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
      });
      await prisma.interactionLog.create({
        data: { relationId: relation.id, date: daysAgo(90), notes: 'Welcome email', type: 'Email' },
      });
      relations.push(relation);
    }

    await sweepDormantFirstContacts();
    const flagged = await prisma.mentorshipRelation.findMany({
      where: { id: { in: relations.map((r) => r.id) } },
      select: { id: true, dormantSince: true },
    });
    // Both really are dormant — otherwise the rest of this proves nothing.
    expect(flagged.every((r) => r.dormantSince !== null)).toBe(true);

    const spent = async () => {
      const rows = await prisma.mentorshipRelation.findMany({
        where: { id: { in: relations.map((r) => r.id) } },
        select: { dormantNudgeCount: true },
      });
      return rows.reduce((total, row) => total + row.dormantNudgeCount, 0);
    };

    // One run: one mail, one nudge spent across BOTH relations.
    await sendDormantCheckIns();
    expect(await spent()).toBe(1);

    // The next day is the case the in-memory Set of #2283 could not cover: the
    // second relation still had an untouched budget, so the extra mail was
    // deferred rather than cancelled. The spacing rule now reads the person's
    // last nudge, whichever relation sent it.
    await sendDormantCheckIns(new Date(Date.now() + DAY));
    expect(await spent()).toBe(1);

    // A month later the SECOND and final mail goes out — and that is the whole
    // budget for this human, forever. Not two per relation, not four.
    await sendDormantCheckIns(new Date(Date.now() + 32 * DAY));
    expect(await spent()).toBe(DORMANT_MAX_NUDGES);
    await sendDormantCheckIns(new Date(Date.now() + 400 * DAY));
    expect(await spent()).toBe(DORMANT_MAX_NUDGES);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
  }
});

test('two ACTIVE relations produce ONE weekly-report reminder, not two', async () => {
  const menteeEmail = uniqueEmail('caps-weekly-mentee');
  const mentorAEmail = uniqueEmail('caps-weekly-mentor-a');
  const mentorBEmail = uniqueEmail('caps-weekly-mentor-b');
  try {
    const mentee = await seedUser(menteeEmail, 'CapsPass123', 'MENTEE', 'Weekly Doubled');
    const mentorA = await seedUser(mentorAEmail, 'CapsPass123', 'MENTOR', 'Weekly Mentor A');
    const mentorB = await seedUser(mentorBEmail, 'CapsPass123', 'MENTOR', 'Weekly Mentor B');

    const relations: { id: string }[] = [];
    for (const mentor of [mentorA, mentorB]) {
      relations.push(
        await prisma.mentorshipRelation.create({
          data: {
            mentorId: mentor.id,
            menteeId: mentee.id,
            status: 'ACTIVE',
            pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450',
          },
        })
      );
    }

    const before = await prisma.notification.count({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' } });

    await sendWeeklyReportReminders();

    // One claim row for the person this week, not one per relation.
    const claims = await prisma.weeklyReportReminder.findMany({
      where: { relationId: { in: relations.map((r) => r.id) } },
      select: { relationId: true, recipientId: true },
    });
    expect(claims).toHaveLength(1);
    // And it records WHO it was for — the column that makes "has this human
    // been reminded this week?" answerable at all.
    expect(claims[0].recipientId).toBe(mentee.id);

    // One bell item, not two.
    const after = await prisma.notification.count({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' } });
    expect(after - before).toBe(1);

    // A second run in the same week adds nothing, through either relation.
    await sendWeeklyReportReminders();
    expect(
      await prisma.weeklyReportReminder.count({ where: { relationId: { in: relations.map((r) => r.id) } } })
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' } })
    ).toBe(after);
  } finally {
    await prisma.weeklyReportReminder.deleteMany({ where: { recipient: { email: menteeEmail } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
  }
});
