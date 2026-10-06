import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// Nobody gets double-booked (#1995). Every write path that puts a meeting on a
// calendar — schedule, move, request, accept — refuses an hour one of the pair
// already has, server-side, with a 409 naming what is in the way. A recurring
// series counts although it is not stored as rows, a bulk schedule books the
// free pairs and reports the rest, and `force` books over it on purpose and
// leaves an audit trail.

const PW = 'DoubleBook123!';
const HOUR = 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** A whole UTC hour some days out — far from anything another spec books. */
function slotAt(daysOut: number, hourUtc: number): Date {
  const d = new Date(Date.now() + daysOut * 24 * HOUR);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function seedPair(prefix: string, menteeCount = 1) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', `${prefix} Mentor`);
  const mentees: { email: string; id: string }[] = [];
  const relations: { id: string; menteeId: string }[] = [];
  for (let i = 0; i < menteeCount; i++) {
    const email = uniqueEmail(`${prefix}-mentee${i}`);
    const mentee = await seedUser(email, PW, 'MENTEE', `${prefix} Mentee ${i}`);
    mentees.push({ email, id: mentee.id });
    relations.push(await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id }, select: { id: true, menteeId: true } }));
  }
  const relIds = relations.map((r) => r.id);
  return {
    mentorEmail,
    mentor,
    mentees,
    relations,
    async cleanup(extra: () => Promise<unknown> = async () => {}) {
      await extra();
      await prisma.auditLog.deleteMany({ where: { actorId: mentor.id } });
      await prisma.meeting.deleteMany({ where: { relationId: { in: relIds } } });
      await prisma.meetingSeries.deleteMany({ where: { relationId: { in: relIds } } });
      await prisma.meetingRequest.deleteMany({ where: { relationId: { in: relIds } } });
      await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
      await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, ...mentees.map((m) => m.id)] } } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relIds } } });
      for (const m of mentees) await cleanupByEmail(m.email);
      await cleanupByEmail(mentorEmail);
    },
  };
}

function seedMeeting(data: { relationId?: string; projectId?: string; title: string; scheduledAt: Date; createdById: string; durationMinutes?: number }) {
  return prisma.meeting.create({ data: { ...data, rsvpToken: randomBytes(16).toString('hex') } });
}

test('an overlapping booking is refused with the collision named; back to back and force go through', { tag: '@smoke' }, async ({ page }) => {
  const s = await seedPair('db-basic');
  const rel = s.relations[0];
  const at = slotAt(20, 9);
  try {
    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');
    const first = await page.request.post('/api/meetings', { data: { relationIds: [rel.id], title: 'Kickoff', scheduledAt: at.toISOString() } });
    expect(first.ok()).toBeTruthy();
    expect((await first.json()).created).toBe(1);

    // Half an hour into a 60-minute meeting: refused, and the 409 says by what.
    const clash = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Second', scheduledAt: new Date(at.getTime() + HOUR / 2).toISOString() },
    });
    expect(clash.status()).toBe(409);
    const body = await clash.json();
    expect(body.code).toBe('conflict');
    expect(body.conflictsWith).toEqual({ title: 'Kickoff', startsAt: at.toISOString() });
    expect(await prisma.meeting.count({ where: { relationId: rel.id } })).toBe(1);

    // Half-open: starting the minute the first one ends is not a clash.
    const next = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Right after', scheduledAt: new Date(at.getTime() + HOUR).toISOString() },
    });
    expect(next.ok()).toBeTruthy();
    expect((await next.json()).created).toBe(1);

    // On purpose: booked, and recorded.
    const forced = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Forced', scheduledAt: new Date(at.getTime() + HOUR / 4).toISOString(), force: true },
    });
    expect(forced.ok()).toBeTruthy();
    expect((await forced.json()).created).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: s.mentor.id, action: 'meeting.forceConflict' } });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.detail ?? '{}').over).toBe('Kickoff');

    // A cancelled meeting frees its hour.
    await prisma.meeting.updateMany({ where: { relationId: rel.id }, data: { status: 'CANCELLED' } });
    const freed = await page.request.post('/api/meetings', { data: { relationIds: [rel.id], title: 'Again', scheduledAt: at.toISOString() } });
    expect(freed.ok()).toBeTruthy();
  } finally {
    await s.cleanup();
  }
});

test('a recurring series occurrence is a conflict although it is not a stored row', async ({ page }) => {
  const s = await seedPair('db-series');
  const rel = s.relations[0];
  const at = slotAt(9, 14);
  try {
    await prisma.meetingSeries.create({
      data: {
        relationId: rel.id,
        title: 'Weekly sync',
        daysOfWeek: [at.getUTCDay()],
        timeOfDay: '14:00',
        timeZone: 'UTC',
        durationMinutes: 30,
        createdById: s.mentor.id,
      },
    });
    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');
    const clash = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'One-off', scheduledAt: new Date(at.getTime() - HOUR / 2 + 60_000).toISOString() },
    });
    expect(clash.status()).toBe(409);
    expect((await clash.json()).conflictsWith).toEqual({ title: 'Weekly sync', startsAt: at.toISOString() });

    // The 30-minute occurrence is over at 14:30.
    const after = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'After sync', scheduledAt: new Date(at.getTime() + HOUR / 2).toISOString() },
    });
    expect(after.ok()).toBeTruthy();
  } finally {
    await s.cleanup();
  }
});

test('a bulk schedule books the free pairs and reports the clash — without naming a meeting the caller is not in', async ({ page }) => {
  const s = await seedPair('db-bulk', 2);
  const at = slotAt(11, 10);
  const project = await prisma.project.create({
    data: { name: `DB Project ${Date.now()}`, ownerType: 'MENTOR', ownerUserId: s.mentees[1].id, members: { create: [{ userId: s.mentees[1].id, role: 'MENTEE' }] } },
  });
  try {
    // Mentee 1 is busy in a project room the mentor has nothing to do with.
    await seedMeeting({ projectId: project.id, title: 'Private standup', scheduledAt: at, createdById: s.mentees[1].id });
    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');
    const res = await page.request.post('/api/meetings', {
      data: { relationIds: s.relations.map((r) => r.id), title: 'Group session', scheduledAt: at.toISOString() },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // The mentor sits in both rows of the same session — that is one room, not a clash.
    expect(body.created).toBe(1);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].relationId).toBe(s.relations[1].id);
    expect(body.conflicts[0].conflictsWith).toEqual({ title: '', startsAt: at.toISOString() });
    expect(await prisma.meeting.count({ where: { relationId: s.relations[0].id } })).toBe(1);
    expect(await prisma.meeting.count({ where: { relationId: s.relations[1].id } })).toBe(0);
  } finally {
    await s.cleanup(async () => {
      await prisma.meeting.deleteMany({ where: { projectId: project.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  }
});

test('two bookings of the same hour in the same instant make one meeting and one 409', async ({ page }) => {
  const s = await seedPair('db-race');
  const rel = s.relations[0];
  const at = slotAt(13, 8);
  try {
    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');
    const post = (title: string) => page.request.post('/api/meetings', { data: { relationIds: [rel.id], title, scheduledAt: at.toISOString() } });
    const results = await Promise.all([post('Race A'), post('Race B'), post('Race C')]);
    const statuses = results.map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await prisma.meeting.count({ where: { relationId: rel.id } })).toBe(1);
  } finally {
    await s.cleanup();
  }
});

test('moving a meeting onto another one is refused; force from the mentor moves it', async ({ page }) => {
  const s = await seedPair('db-move');
  const rel = s.relations[0];
  const a = slotAt(15, 9);
  const b = slotAt(15, 12);
  try {
    const fixed = await seedMeeting({ relationId: rel.id, title: 'Fixed', scheduledAt: a, createdById: s.mentor.id });
    const mover = await seedMeeting({ relationId: rel.id, title: 'Mover', scheduledAt: b, createdById: s.mentor.id });
    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');

    const onto = new Date(a.getTime() + HOUR / 2);
    const refused = await page.request.patch(`/api/meetings/${mover.id}`, { data: { scheduledAt: onto.toISOString() } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).conflictsWith.title).toBe('Fixed');
    expect((await prisma.meeting.findUnique({ where: { id: mover.id } }))?.scheduledAt?.getTime()).toBe(b.getTime());

    // A meeting does not collide with its own old slot: lengthening it in place is fine.
    const longer = await page.request.patch(`/api/meetings/${mover.id}`, { data: { durationMinutes: 90 } });
    expect(longer.ok()).toBeTruthy();
    // …but lengthening the fixed one into the mover is not.
    const tooLong = await page.request.patch(`/api/meetings/${fixed.id}`, { data: { durationMinutes: 240 } });
    expect(tooLong.status()).toBe(409);

    const forced = await page.request.patch(`/api/meetings/${mover.id}`, { data: { scheduledAt: onto.toISOString(), force: true } });
    expect(forced.ok()).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { actorId: s.mentor.id, action: 'meeting.forceConflict', targetId: mover.id } })).toBe(1);
  } finally {
    await s.cleanup();
  }
});

test('a request for a taken hour is refused, the picker stops offering it, and an accept re-checks', async ({ page }) => {
  test.slow();
  const s = await seedPair('db-req', 2);
  const [mine, other] = s.relations;
  const at = slotAt(17, 15);
  try {
    // The mentor's Tuesday 15:00 already belongs to the other mentee.
    await seedMeeting({ relationId: other.id, title: 'Other mentee 1:1', scheduledAt: at, createdById: s.mentor.id });
    await prisma.availabilitySlot.create({ data: { mentorId: s.mentor.id, weekday: at.getUTCDay(), startTime: '15:00', endTime: '16:00' } });
    await prisma.user.update({ where: { id: s.mentor.id }, data: { timezone: 'UTC' } });

    await signInAsFreshUser(page, s.mentees[0].email, PW, '/portal');
    const refused = await page.request.post('/api/meeting-requests', { data: { relationId: mine.id, topic: 'Career', proposedAt: at.toISOString() } });
    expect(refused.status()).toBe(409);
    // Taken — but by whom and for what is not this mentee's business.
    expect((await refused.json()).conflictsWith).toEqual({ title: '', startsAt: at.toISOString() });

    const avail = await (await page.request.get(`/api/availability?mentorId=${s.mentor.id}`)).json();
    expect(avail.busy).toContainEqual({ start: at.toISOString(), end: new Date(at.getTime() + HOUR).toISOString() });
    expect(JSON.stringify(avail)).not.toContain('Other mentee 1:1');

    // A free hour is requested; it gets taken before the mentor accepts.
    const free = new Date(at.getTime() + 2 * HOUR);
    const created = await page.request.post('/api/meeting-requests', { data: { relationId: mine.id, topic: 'Career', proposedAt: free.toISOString() } });
    expect(created.status()).toBe(201);
    const reqId = (await created.json()).request.id;
    await seedMeeting({ relationId: other.id, title: 'Grabbed it', scheduledAt: free, createdById: s.mentor.id });

    await signInAsFreshUser(page, s.mentorEmail, PW, '/mentor');
    const accept = await page.request.patch(`/api/meeting-requests/${reqId}`, { data: { action: 'accept' } });
    expect(accept.status()).toBe(409);
    expect((await accept.json()).conflictsWith.title).toBe('Grabbed it');
    expect((await prisma.meetingRequest.findUnique({ where: { id: reqId } }))?.status).toBe('PENDING');
    expect(await prisma.meeting.count({ where: { relationId: mine.id } })).toBe(0);
  } finally {
    await s.cleanup();
  }
});
