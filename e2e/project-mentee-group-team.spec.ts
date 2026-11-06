import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3584: a mentee owner's circle (#2272) reads group relations (#1804) too —
// the group's mentors and its other mentees — and only ACTIVE participation:
// a seat that was left, a benched person, a completed group and a person of
// another org (even one seated in the group) all stay outside, answering the
// same 404 an unknown id gets.

test('a mentee owner adds the people of their active group, and nobody whose seat no longer counts', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const pw = 'GroupTeam123!';
  const stamp = `${Date.now()}`;
  const tags = ['owner', 'lead', 'co', 'peer', 'left', 'benched', 'oldLead', 'oldPeer', 'foreign'] as const;
  const emails = Object.fromEntries(tags.map((t) => [t, uniqueEmail(`gt-${t.toLowerCase()}`)])) as Record<(typeof tags)[number], string>;
  const orgB = await prisma.organization.create({
    data: { name: `GT Other ${stamp}`, slug: `gt-other-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const owner = await seedUser(emails.owner, pw, 'MENTEE', 'GT Owner');
  const lead = await seedUser(emails.lead, pw, 'MENTOR', 'GT Lead');
  const co = await seedUser(emails.co, pw, 'MENTOR', 'GT Co-mentor');
  const peer = await seedUser(emails.peer, pw, 'MENTEE', 'GT Peer');
  const left = await seedUser(emails.left, pw, 'MENTEE', 'GT Left');
  const benched = await seedUser(emails.benched, pw, 'MENTEE', 'GT Benched');
  const oldLead = await seedUser(emails.oldLead, pw, 'MENTOR', 'GT Old Lead');
  const oldPeer = await seedUser(emails.oldPeer, pw, 'MENTEE', 'GT Old Peer');
  const foreign = await seedUser(emails.foreign, pw, 'MENTEE', 'GT Foreign', orgB.id);
  await prisma.user.update({ where: { id: benched.id }, data: { participantState: 'BENCHED' } });

  // The live group: the owner is a non-primary mentee seat, so nothing here is
  // reachable through the 1:1 scalars the #2272 rule used to read.
  const group = await prisma.mentorshipRelation.create({
    data: {
      mentorId: lead.id, menteeId: peer.id, relationType: 'GROUP', status: 'ACTIVE',
      participants: {
        create: [
          { userId: lead.id, role: 'MENTOR', isPrimaryPair: true },
          { userId: peer.id, role: 'MENTEE', isPrimaryPair: true },
          { userId: owner.id, role: 'MENTEE' },
          { userId: co.id, role: 'MENTOR' },
          { userId: left.id, role: 'MENTEE', leftAt: new Date() },
          { userId: benched.id, role: 'MENTEE' },
          // Bad data on purpose: a person of another org holding a seat.
          { userId: foreign.id, role: 'MENTEE' },
        ],
      },
    },
  });
  // A finished group the owner was in: none of it counts any more.
  const done = await prisma.mentorshipRelation.create({
    data: {
      mentorId: oldLead.id, menteeId: oldPeer.id, relationType: 'GROUP', status: 'COMPLETED',
      participants: {
        create: [
          { userId: oldLead.id, role: 'MENTOR', isPrimaryPair: true },
          { userId: oldPeer.id, role: 'MENTEE', isPrimaryPair: true },
          { userId: owner.id, role: 'MENTEE' },
        ],
      },
    },
  });
  const project = await prisma.project.create({
    data: {
      name: `GT Project ${stamp}`, ownerType: 'MENTEE', ownerUserId: owner.id, isPublic: false,
      members: { create: [{ userId: owner.id, role: 'OWNER' }] },
    },
  });

  try {
    await signInAsFreshUser(page, emails.owner, pw, '/portal');

    const cands = await page.request.get(`/api/projects/${project.id}/members/candidates`);
    expect(cands.status()).toBe(200);
    const offered = (await cands.json()).candidates as { id: string; seats: string[] }[];
    expect(offered.map((c) => c.id).sort()).toEqual([lead.id, co.id, peer.id].sort());

    const add = (userId: string, role: string) =>
      page.request.post(`/api/projects/${project.id}/members`, { data: { userId, role } });

    for (const [userId, role] of [
      [left.id, 'MENTEE'],
      [benched.id, 'MENTEE'],
      [oldLead.id, 'MENTOR'],
      [oldPeer.id, 'MENTEE'],
      [foreign.id, 'MENTEE'],
    ] as const) {
      const res = await add(userId, role);
      expect(res.status(), `${userId} as ${role}`).toBe(404);
      expect((await res.json()).code).toBe('not_addable');
    }

    expect((await add(peer.id, 'MENTEE')).status()).toBe(201);
    expect((await add(co.id, 'MENTOR')).status()).toBe(201);
    expect((await add(lead.id, 'OWNER')).status()).toBe(201);
    expect(
      (await prisma.projectMember.findMany({ where: { projectId: project.id }, select: { userId: true } })).map((m) => m.userId).sort()
    ).toEqual([owner.id, peer.id, co.id, lead.id].sort());
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [lead.id, co.id, peer.id] } } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.relationParticipant.deleteMany({ where: { relationId: { in: [group.id, done.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [group.id, done.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => {});
  }
});
