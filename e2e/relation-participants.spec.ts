import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Relation shapes, the data foundation (#1804). A third member of a GROUP —
// in neither `mentorId` nor `menteeId` — reads the relation and posts in its
// thread, and the post reaches every member; a seat someone left grants
// nothing; a mirror seat of the pair grants nothing either, so a mentor
// corrected in place never keeps access through a stale row; and a mentee
// seated in an active group cannot be given a second, one-to-one mentor.
test('a group seat reads the relation and posts; a left or stale seat grants nothing; one active mentor holds', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'SeatPass123!';
  const org = await prisma.organization.create({ data: { name: `Seats ${stamp}`, slug: `seats-${stamp}` } });
  const ctx = async () => playwright.request.newContext({ baseURL });
  const [admin, third, leaver, oldMentor] = await Promise.all([ctx(), ctx(), ctx(), ctx()]);
  try {
    const adminEmail = uniqueEmail('seats-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Seats Admin', org.id);
    const mentor = await seedUser(uniqueEmail('seats-mentor'), pw, 'MENTOR', 'Group Mentor', org.id);
    const first = await seedUser(uniqueEmail('seats-mentee'), pw, 'MENTEE', 'First Mentee', org.id);
    const thirdUser = await seedUser(uniqueEmail('seats-third'), pw, 'MENTEE', 'Third Mentee', org.id);
    const leaverUser = await seedUser(uniqueEmail('seats-leaver'), pw, 'MENTEE', 'Leaving Mentee', org.id);
    const other = await seedUser(uniqueEmail('seats-other'), pw, 'MENTOR', 'Other Mentor', org.id);

    const group = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: first.id, status: 'ACTIVE', relationType: 'GROUP' },
    });
    await prisma.relationParticipant.createMany({
      data: [
        { relationId: group.id, userId: mentor.id, role: 'MENTOR', isPrimaryPair: true },
        { relationId: group.id, userId: first.id, role: 'MENTEE', isPrimaryPair: true },
        { relationId: group.id, userId: thirdUser.id, role: 'MENTEE' },
        { relationId: group.id, userId: leaverUser.id, role: 'MENTEE', leftAt: new Date() },
      ],
    });

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    expect((await signInViaApi(third, thirdUser.email, pw)).ok).toBe(true);
    expect((await signInViaApi(leaver, leaverUser.email, pw)).ok).toBe(true);
    expect((await signInViaApi(oldMentor, other.email, pw)).ok).toBe(true);

    // The third member is in neither scalar, and reads the relation.
    const read = await third.get(`/api/mentorship/${group.id}`);
    expect(read.status(), await read.text()).toBe(200);
    // …and posts in its thread; the post reaches the mentor AND the first mentee.
    const posted = await third.post('/api/messages', { data: { relationId: group.id, body: 'Hello group' } });
    expect(posted.status(), await posted.text()).toBe(201);
    const thread = await (await third.get(`/api/messages?relationId=${group.id}`)).json();
    expect(thread.messages.map((m: { body: string }) => m.body)).toContain('Hello group');
    await expect.poll(() => prisma.notification.count({ where: { userId: { in: [mentor.id, first.id] } } })).toBeGreaterThanOrEqual(2);

    // A seat someone left is history, not access.
    expect((await leaver.get(`/api/mentorship/${group.id}`)).status()).toBe(403);
    expect((await leaver.post('/api/messages', { data: { relationId: group.id, body: 'Still here?' } })).ok()).toBe(false);

    // A mirror seat grants nothing: correct the mentor in place, and the old
    // mirror row names somebody who is no longer the pair.
    const pair = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: other.id, menteeId: leaverUser.id, status: 'ACTIVE' } });
    await prisma.relationParticipant.createMany({
      data: [
        { relationId: pair.id, userId: other.id, role: 'MENTOR', isPrimaryPair: true },
        { relationId: pair.id, userId: leaverUser.id, role: 'MENTEE', isPrimaryPair: true },
      ],
    });
    expect((await oldMentor.get(`/api/mentorship/${pair.id}`)).status()).toBe(200);
    await prisma.mentorshipRelation.update({ where: { id: pair.id }, data: { mentorId: mentor.id } });
    expect((await oldMentor.get(`/api/mentorship/${pair.id}`)).status()).toBe(403);

    // One active mentor (#419): the third member is mentored by the group, so
    // a direct one-to-one assignment is refused with the usual code.
    const second = await admin.post('/api/mentorship', { data: { mentorId: other.id, menteeId: thirdUser.id } });
    expect(second.status()).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'already_mentored', activeRelationId: group.id });

    // The shared create path writes the pair's mirror seats.
    const direct = await admin.post('/api/mentorship', { data: { mentorId: other.id, menteeId: (await seedUser(uniqueEmail('seats-new'), pw, 'MENTEE', 'New Mentee', org.id)).id } });
    expect(direct.status(), await direct.text()).toBe(201);
    const created = (await direct.json()).relation as { id: string };
    expect(await prisma.relationParticipant.count({ where: { relationId: created.id, isPrimaryPair: true } })).toBe(2);
    expect((await prisma.mentorshipRelation.findUnique({ where: { id: created.id } }))?.relationType).toBe('ONE_TO_ONE');
  } finally {
    await Promise.all([admin, third, leaver, oldMentor].map((c) => c.dispose()));
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.message.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
