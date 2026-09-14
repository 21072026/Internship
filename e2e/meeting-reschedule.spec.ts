import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

/**
 * A meeting you can change (#1980).
 *
 * PATCH /api/meetings/[id] moves it or calls it off; DELETE removes the row.
 * The three things these tests exist to pin down:
 *
 *   1. WHO. Being in a meeting is not being in charge of it — the mentee is a
 *      participant and gets the same 404 as a stranger, so the id space never
 *      tells them the meeting exists.
 *   2. WHAT ELSE moves with the time: `reminderSentAt` is cleared (or the new
 *      time silently gets no reminder), the old time is remembered, and an RSVP
 *      given to the old time no longer counts for the new one.
 *   3. WHAT SURVIVES a delete: the note and the interaction log written in the
 *      meeting are `onDelete: SetNull`, deliberately — deleting a meeting must
 *      not delete what was written in it.
 */

const password = 'ReschedulePass123!';
const daysFromNow = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Reschedule Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Reschedule Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

async function seedMeeting(opts: {
  relationId: string;
  createdById: string;
  scheduledAt: Date;
  title: string;
  batchKey?: string;
  reminderSentAt?: Date | null;
}) {
  return prisma.meeting.create({
    data: {
      relationId: opts.relationId,
      title: opts.title,
      scheduledAt: opts.scheduledAt,
      meetLink: 'https://meet.example.com/reschedule-room',
      rsvpToken: `e2e-${Math.random().toString(36).slice(2)}`,
      createdById: opts.createdById,
      rsvp: 'ACCEPTED',
      reminderSentAt: opts.reminderSentAt ?? new Date(),
      ...(opts.batchKey ? { batchKey: opts.batchKey } : {}),
    },
  });
}

test('a mentor moves a meeting and then calls it off — a mentee may do neither', { tag: '@smoke' }, async ({ page }) => {
  const { mentorEmail, menteeEmail, mentor, relation } = await seedPair('resched');
  const meeting = await seedMeeting({
    relationId: relation.id,
    createdById: mentor.id,
    scheduledAt: daysFromNow(2),
    title: 'Portfolio review',
  });

  try {
    // 1. The mentee is IN this meeting and still may not change it. "Not yours"
    //    answers exactly like "no such meeting".
    await signInAndSettle(page, menteeEmail, password, '/portal');
    const menteeMove = await page.request.patch(`/api/meetings/${meeting.id}`, {
      data: { scheduledAt: daysFromNow(5).toISOString() },
    });
    expect(menteeMove.status()).toBe(404);
    const menteeDelete = await page.request.delete(`/api/meetings/${meeting.id}`);
    expect(menteeDelete.status()).toBe(404);
    const untouched = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    expect(untouched?.scheduledAt?.getTime()).toBe(meeting.scheduledAt!.getTime());
    expect(untouched?.status).toBe('SCHEDULED');

    // 2. The mentor moves it.
    await signInAsFreshUser(page, mentorEmail, password, '/mentor');
    const newTime = daysFromNow(5);
    newTime.setSeconds(0, 0);
    const moved = await page.request.patch(`/api/meetings/${meeting.id}`, {
      data: { scheduledAt: newTime.toISOString(), timeZone: 'Europe/Istanbul' },
    });
    expect(moved.status()).toBe(200);

    const afterMove = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    expect(afterMove?.scheduledAt?.getTime()).toBe(newTime.getTime());
    expect(afterMove?.previousScheduledAt?.getTime()).toBe(meeting.scheduledAt!.getTime());
    expect(afterMove?.rescheduledAt).not.toBeNull();
    // Cleared, or the reminder cron (which only ever looks at nulls) would treat
    // the new time as already reminded about.
    expect(afterMove?.reminderSentAt).toBeNull();
    // An answer given to the old time is not an answer to this one.
    expect(afterMove?.rsvp).toBe('PENDING');
    expect(afterMove?.timeZone).toBe('Europe/Istanbul');

    // The calendar reports the new time, not the old one.
    const events = await page.request.get('/api/calendar-events');
    const listed = (await events.json()).events.filter((e: { id: string }) => e.id.includes(meeting.id));
    expect(listed).toHaveLength(1);
    expect(new Date(listed[0].date).getTime()).toBe(newTime.getTime());

    // 3. And then calls it off, with a reason.
    const cancelled = await page.request.patch(`/api/meetings/${meeting.id}`, {
      data: { status: 'CANCELLED', cancelReason: 'Company visit moved' },
    });
    expect(cancelled.status()).toBe(200);

    const afterCancel = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    expect(afterCancel?.status).toBe('CANCELLED');
    expect(afterCancel?.cancelledById).toBe(mentor.id);
    expect(afterCancel?.cancelledAt).not.toBeNull();
    expect(afterCancel?.cancelReason).toBe('Company visit moved');

    // Off the calendar, and not movable a second time.
    const afterEvents = await page.request.get('/api/calendar-events');
    const stillListed = (await afterEvents.json()).events.filter((e: { id: string }) => e.id.includes(meeting.id));
    expect(stillListed).toHaveLength(0);
    const again = await page.request.patch(`/api/meetings/${meeting.id}`, {
      data: { scheduledAt: daysFromNow(9).toISOString() },
    });
    expect(again.status()).toBe(409);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('deleting a meeting keeps the note and the interaction log written in it', async ({ page }) => {
  const { mentorEmail, menteeEmail, mentor, relation } = await seedPair('resdel');
  const meeting = await seedMeeting({
    relationId: relation.id,
    createdById: mentor.id,
    scheduledAt: daysFromNow(3),
    title: 'Deletable kickoff',
  });
  const note = await prisma.personalNote.create({
    data: { userId: mentor.id, category: 'MEETING', meetingId: meeting.id, body: 'Ask about the CV gap' },
  });
  const log = await prisma.interactionLog.create({
    data: {
      relationId: relation.id,
      date: new Date(),
      type: 'Meeting',
      notes: 'Talked through the portfolio',
      meetingId: meeting.id,
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const removed = await page.request.delete(`/api/meetings/${meeting.id}`);
    expect(removed.status()).toBe(200);
    expect(await removed.json()).toMatchObject({ deleted: 1 });

    expect(await prisma.meeting.findUnique({ where: { id: meeting.id } })).toBeNull();
    // SetNull, not Cascade: the durable part is what was written.
    const keptNote = await prisma.personalNote.findUnique({ where: { id: note.id } });
    expect(keptNote?.meetingId).toBeNull();
    expect(keptNote?.body).toBe('Ask about the CV gap');
    const keptLog = await prisma.interactionLog.findUnique({ where: { id: log.id } });
    expect(keptLog?.meetingId).toBeNull();
    expect(keptLog?.notes).toBe('Talked through the portfolio');
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await prisma.personalNote.deleteMany({ where: { userId: mentor.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('scope decides whether a bulk schedule is cancelled as one row or as a session', async ({ page }) => {
  const first = await seedPair('resbatch-a');
  const second = await seedPair('resbatch-b');
  // Two rows of one bulk schedule: same organiser, same room, same batch key.
  const batchKey = `e2e-batch-${Math.random().toString(36).slice(2)}`;
  const when = daysFromNow(4);
  const rowA = await seedMeeting({
    relationId: first.relation.id,
    createdById: first.mentor.id,
    scheduledAt: when,
    title: 'Group session',
    batchKey,
  });
  const rowB = await seedMeeting({
    relationId: second.relation.id,
    createdById: first.mentor.id,
    scheduledAt: when,
    title: 'Group session',
    batchKey,
  });

  try {
    // A mentor from a different pair is neither the organiser nor this
    // relation's mentor, so the row is not theirs to touch — same 404 as an id
    // that does not exist.
    await signInAndSettle(page, second.mentorEmail, password, '/mentor');
    const stranger = await page.request.patch(`/api/meetings/${rowA.id}`, {
      data: { status: 'CANCELLED' },
    });
    expect(stranger.status()).toBe(404);

    // The organiser of the whole batch signs in.
    await signInAsFreshUser(page, first.mentorEmail, password, '/mentor');

    // Default scope: this row only.
    const one = await page.request.patch(`/api/meetings/${rowA.id}`, {
      data: { status: 'CANCELLED', cancelReason: 'Only this pair' },
    });
    expect(one.status()).toBe(200);
    expect(await one.json()).toMatchObject({ changed: 1 });
    expect((await prisma.meeting.findUnique({ where: { id: rowB.id } }))?.status).toBe('SCHEDULED');

    // Batch scope from the surviving row: the whole session goes.
    const batch = await page.request.patch(`/api/meetings/${rowB.id}`, {
      data: { status: 'CANCELLED', cancelReason: 'The whole session', scope: 'batch' },
    });
    expect(batch.status()).toBe(200);
    expect((await prisma.meeting.findUnique({ where: { id: rowB.id } }))?.status).toBe('CANCELLED');
  } finally {
    await prisma.meeting.deleteMany({ where: { batchKey } });
    await prisma.auditLog.deleteMany({ where: { actorId: first.mentor.id } });
    await cleanupByEmail(first.mentorEmail);
    await cleanupByEmail(first.menteeEmail);
    await cleanupByEmail(second.mentorEmail);
    await cleanupByEmail(second.menteeEmail);
  }
});

test('a meeting that already happened cannot be moved', async ({ page }) => {
  const { mentorEmail, menteeEmail, mentor, relation } = await seedPair('resended');
  const meeting = await seedMeeting({
    relationId: relation.id,
    createdById: mentor.id,
    scheduledAt: daysFromNow(-1),
    title: 'Already held',
  });
  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { endedAt: new Date(), endedById: mentor.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const res = await page.request.patch(`/api/meetings/${meeting.id}`, {
      data: { scheduledAt: daysFromNow(3).toISOString() },
    });
    expect(res.status()).toBe(410);
    expect((await prisma.meeting.findUnique({ where: { id: meeting.id } }))?.scheduledAt?.getTime()).toBe(
      meeting.scheduledAt!.getTime()
    );
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
