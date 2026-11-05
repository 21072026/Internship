import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2272: a mentee owner manages their own team and weekly meeting.
//
// #2270 let a mentee start a project but refused every direct add
// (`mentee_owner_invite`) and kept the meeting-series writes MENTOR/ADMIN-only,
// because the member POST's relation check ran for mentor actors alone: a
// mentee owner would have seated any mentee of the tenant. The addable set is
// now one pure rule (src/lib/projectTeamRule.ts) — a mentee owner seats their
// own mentor and that mentor's other mentees, nobody else — and everything
// outside it, a missing id and another tenant's person included, answers 404.

test('a mentee owner seats only their own circle, and runs only their own project’s series', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const pw = 'MenteeTeam123!';
  const emails = {
    owner: uniqueEmail('mt-owner'),
    mentor: uniqueEmail('mt-mentor'),
    peer: uniqueEmail('mt-peer'),
    stranger: uniqueEmail('mt-stranger'),
    otherMentor: uniqueEmail('mt-other-mentor'),
    otherOwner: uniqueEmail('mt-other-owner'),
    foreign: uniqueEmail('mt-foreign'),
  };
  const stamp = `${Date.now()}`;
  const orgB = await prisma.organization.create({
    data: { name: `MT Other ${stamp}`, slug: `mt-other-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const owner = await seedUser(emails.owner, pw, 'MENTEE', 'MT Owner');
  const mentor = await seedUser(emails.mentor, pw, 'MENTOR', 'MT Mentor');
  const peer = await seedUser(emails.peer, pw, 'MENTEE', 'MT Peer');
  const stranger = await seedUser(emails.stranger, pw, 'MENTEE', 'MT Stranger');
  const otherMentor = await seedUser(emails.otherMentor, pw, 'MENTOR', 'MT Other Mentor');
  const otherOwner = await seedUser(emails.otherOwner, pw, 'MENTEE', 'MT Other Owner');
  const foreign = await seedUser(emails.foreign, pw, 'MENTEE', 'MT Foreign', orgB.id);

  // The owner and the peer share one ACTIVE mentor; the stranger has another.
  await prisma.mentorshipRelation.createMany({
    data: [
      { mentorId: mentor.id, menteeId: owner.id, status: 'ACTIVE' },
      { mentorId: mentor.id, menteeId: peer.id, status: 'ACTIVE' },
      { mentorId: otherMentor.id, menteeId: stranger.id, status: 'ACTIVE' },
    ],
  });
  const ownRelation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: owner.id } });

  const mine = await prisma.project.create({
    data: {
      name: `MT Mine ${stamp}`, ownerType: 'MENTEE', ownerUserId: owner.id, isPublic: false,
      members: { create: [{ userId: owner.id, role: 'OWNER' }] },
    },
  });
  const theirs = await prisma.project.create({
    data: {
      name: `MT Theirs ${stamp}`, ownerType: 'MENTEE', ownerUserId: otherOwner.id, isPublic: true,
      members: { create: [{ userId: otherOwner.id, role: 'OWNER' }] },
    },
  });
  const theirSeries = await prisma.meetingSeries.create({
    data: { projectId: theirs.id, title: 'MT Their Sync', daysOfWeek: [1], timeOfDay: '09:00', timeZone: 'UTC', createdById: otherOwner.id },
  });

  try {
    await signInAsFreshUser(page, emails.owner, pw, '/portal');

    // The picker offers exactly the set the write accepts.
    const cands = await page.request.get(`/api/projects/${mine.id}/members/candidates`);
    expect(cands.status()).toBe(200);
    const offered = (await cands.json()).candidates as { id: string; seats: string[] }[];
    expect(offered.map((c) => c.id).sort()).toEqual([mentor.id, peer.id].sort());
    expect(offered.find((c) => c.id === peer.id)?.seats).toEqual(['MENTEE']);

    const add = (projectId: string, userId: string, role: string) =>
      page.request.post(`/api/projects/${projectId}/members`, { data: { userId, role } });

    // Outside the circle — an unconnected mentee or mentor of the same org,
    // another tenant's person, an id that matches nobody: all the same 404.
    for (const [userId, role] of [
      [stranger.id, 'MENTEE'],
      [otherMentor.id, 'MENTOR'],
      [foreign.id, 'MENTEE'],
      ['no-such-user-id', 'MENTEE'],
    ] as const) {
      const res = await add(mine.id, userId, role);
      expect(res.status(), `${userId} as ${role}`).toBe(404);
      expect((await res.json()).code).toBe('not_addable');
    }
    // A known person in a seat they cannot hold is a plain 400.
    expect((await add(mine.id, peer.id, 'OWNER')).status()).toBe(400);
    expect(await prisma.projectMember.count({ where: { projectId: mine.id } })).toBe(1);

    // Inside it: the peer as a contributor, the mentor as a mentor member.
    expect((await add(mine.id, peer.id, 'MENTEE')).status()).toBe(201);
    expect((await add(mine.id, mentor.id, 'MENTOR')).status()).toBe(201);
    expect(
      (await prisma.projectMember.findMany({ where: { projectId: mine.id }, select: { userId: true } })).map((m) => m.userId).sort()
    ).toEqual([owner.id, peer.id, mentor.id].sort());

    // Someone else's project, even a public one, is a missing one for the
    // roster, the picker and the write — no 403 that confirms the id.
    expect((await page.request.get(`/api/projects/${theirs.id}/members`)).status()).toBe(404);
    expect((await page.request.get(`/api/projects/${theirs.id}/members/candidates`)).status()).toBe(404);
    expect((await add(theirs.id, peer.id, 'MENTEE')).status()).toBe(404);
    expect(await prisma.projectMember.count({ where: { projectId: theirs.id } })).toBe(1);

    // The weekly meeting of their own project: create, move, cancel.
    const created = await page.request.post('/api/meeting-series', {
      data: { projectId: mine.id, title: 'MT Weekly', daysOfWeek: [2], timeOfDay: '10:00', timeZone: 'UTC', meetLink: '' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const seriesId = (await created.json()).series.id as string;
    const moved = await page.request.put('/api/meeting-series', { data: { id: seriesId, timeOfDay: '11:30' } });
    expect(moved.status()).toBe(200);
    // …but never into someone else's project.
    const adopt = await page.request.put('/api/meeting-series', { data: { id: seriesId, projectId: theirs.id } });
    expect(adopt.status()).toBe(404);
    expect((await prisma.meetingSeries.findUniqueOrThrow({ where: { id: seriesId } })).projectId).toBe(mine.id);
    const cancelled = await page.request.delete('/api/meeting-series', { data: { id: seriesId } });
    expect(cancelled.status()).toBe(200);

    // Another mentee's project series: not created, not changed, not cancelled.
    const foreignCreate = await page.request.post('/api/meeting-series', {
      data: { projectId: theirs.id, title: 'MT Hijack', daysOfWeek: [3], timeOfDay: '08:00', timeZone: 'UTC', meetLink: '' },
    });
    expect(foreignCreate.status()).toBe(404);
    expect((await page.request.put('/api/meeting-series', { data: { id: theirSeries.id, timeOfDay: '23:00' } })).status()).toBe(404);
    expect((await page.request.delete('/api/meeting-series', { data: { id: theirSeries.id } })).status()).toBe(404);
    const untouched = await prisma.meetingSeries.findUniqueOrThrow({ where: { id: theirSeries.id } });
    expect(untouched).toMatchObject({ timeOfDay: '09:00', active: true });
    expect(await prisma.meetingSeries.count({ where: { projectId: theirs.id } })).toBe(1);

    // A standing 1:1 stays the mentor's: the mentee reads it, never writes it.
    const relSeries = await page.request.post('/api/meeting-series', {
      data: { relationId: ownRelation.id, title: 'MT 1:1', daysOfWeek: [4], timeOfDay: '09:00', timeZone: 'UTC', meetLink: '' },
    });
    expect(relSeries.status()).toBe(403);
  } finally {
    await prisma.meetingSeries.deleteMany({ where: { projectId: { in: [mine.id, theirs.id] } } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, peer.id] } } });
    await prisma.project.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => {});
  }
});
