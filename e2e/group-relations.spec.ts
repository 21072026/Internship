import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// Group relations, the admin surface (#1804). An admin forms a GROUP of one
// mentor and three mentees — ONE relation, the first mentee the pair, the
// other two seats; the third mentee reads it and posts in its thread. A
// mentee already mentored elsewhere is refused (#419) and nothing is written;
// a seat is let go with `leftAt` (and its holder loses access); the pair
// cannot be unseated; and a one-to-one takes no further members.
test('an admin forms a group, seats and unseats members; the invariant and the pair hold', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'GroupPass123!';
  const org = await prisma.organization.create({ data: { name: `Groups ${stamp}`, slug: `groups-${stamp}` } });
  const ctx = async () => playwright.request.newContext({ baseURL });
  const [admin, third] = await Promise.all([ctx(), ctx()]);
  try {
    const adminEmail = uniqueEmail('grp-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Group Admin', org.id);
    const mentor = await seedUser(uniqueEmail('grp-mentor'), pw, 'MENTOR', 'Circle Mentor', org.id);
    const [a, b, c, late, taken] = await Promise.all(
      ['A', 'B', 'C', 'Late', 'Taken'].map((n) => seedUser(uniqueEmail(`grp-${n.toLowerCase()}`), pw, 'MENTEE', `Mentee ${n}`, org.id)),
    );
    const other = await seedUser(uniqueEmail('grp-other'), pw, 'MENTOR', 'Other Mentor', org.id);
    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    expect((await signInViaApi(third, c.email, pw)).ok).toBe(true);

    // `taken` already has a one-to-one: a group naming them is refused whole.
    const direct = await admin.post('/api/mentorship', { data: { mentorId: other.id, menteeId: taken.id } });
    expect(direct.status(), await direct.text()).toBe(201);
    const refused = await admin.post('/api/admin/relations/group', { data: { mentorId: mentor.id, menteeIds: [a.id, taken.id] } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'already_mentored', menteeId: taken.id });
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id, relationType: 'GROUP' } })).toBe(0);

    // A group of one is a one-to-one, not a group.
    expect((await admin.post('/api/admin/relations/group', { data: { mentorId: mentor.id, menteeIds: [a.id] } })).status()).toBe(400);

    const formed = await admin.post('/api/admin/relations/group', { data: { mentorId: mentor.id, menteeIds: [a.id, b.id, c.id] } });
    expect(formed.status(), await formed.text()).toBe(201);
    const groupId = (await formed.json()).relation.id as string;
    const group = await prisma.mentorshipRelation.findUnique({ where: { id: groupId } });
    expect(group).toMatchObject({ relationType: 'GROUP', mentorId: mentor.id, menteeId: a.id, status: 'ACTIVE' });

    // The third mentee is in neither scalar: reads the relation, posts in its thread.
    expect((await third.get(`/api/mentorship/${groupId}`)).status()).toBe(200);
    const posted = await third.post('/api/messages', { data: { relationId: groupId, body: 'Hi circle' } });
    expect(posted.status(), await posted.text()).toBe(201);

    // The members list: the pair first, then the seats.
    const list = await (await admin.get(`/api/admin/relations/${groupId}/participants`)).json();
    expect(list.relationType).toBe('GROUP');
    expect(list.participants.map((p: { userId: string; primary: boolean }) => [p.userId, p.primary])).toEqual([
      [mentor.id, true], [a.id, true], [b.id, false], [c.id, false],
    ]);

    // Seat one more; a second seat for the same person is refused.
    expect((await admin.post(`/api/admin/relations/${groupId}/participants`, { data: { userId: late.id, role: 'MENTEE' } })).status()).toBe(201);
    expect((await admin.post(`/api/admin/relations/${groupId}/participants`, { data: { userId: late.id, role: 'MENTEE' } })).status()).toBe(409);
    // …and a mentee mentored elsewhere cannot be seated.
    const seatTaken = await admin.post(`/api/admin/relations/${groupId}/participants`, { data: { userId: taken.id, role: 'MENTEE' } });
    expect(seatTaken.status()).toBe(409);
    expect((await seatTaken.json()).code).toBe('already_mentored');

    // Let the third mentee go: the row stays with `leftAt`, the access goes.
    const left = await admin.delete(`/api/admin/relations/${groupId}/participants?userId=${c.id}`);
    expect(left.status(), await left.text()).toBe(200);
    const seat = await prisma.relationParticipant.findUnique({ where: { relationId_userId: { relationId: groupId, userId: c.id } } });
    expect(seat?.leftAt).not.toBeNull();
    expect((await third.get(`/api/mentorship/${groupId}`)).status()).toBe(403);
    // …and, no longer mentored, they may be paired again.
    const again = await admin.post('/api/mentorship', { data: { mentorId: other.id, menteeId: c.id } });
    expect(again.status(), await again.text()).toBe(201);

    // The pair is changed by a transfer, never by unseating.
    const pairLeave = await admin.delete(`/api/admin/relations/${groupId}/participants?userId=${a.id}`);
    expect(pairLeave.status()).toBe(409);
    expect((await pairLeave.json()).code).toBe('primary_pair');

    // A one-to-one takes no further members.
    const oneToOne = (await direct.json()).relation.id as string;
    const notGroup = await admin.post(`/api/admin/relations/${oneToOne}/participants`, { data: { userId: b.id, role: 'MENTEE' } });
    expect(notGroup.status()).toBe(409);
    expect((await notGroup.json()).code).toBe('not_group');
  } finally {
    await Promise.all([admin, third].map((x) => x.dispose()));
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.message.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

// The screen (#1804): "Form a group" creates one, the card carries the Group
// chip, and its members panel lists the pair and the seats.
test('the admin forms a group from /admin/mentorship and sees its members', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'GroupPass123!';
  const org = await prisma.organization.create({ data: { name: `GroupsUI ${stamp}`, slug: `groups-ui-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('grpui-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Group UI Admin', org.id);
    const mentor = await seedUser(uniqueEmail('grpui-mentor'), pw, 'MENTOR', `Ring Mentor ${stamp}`, org.id);
    const a = await seedUser(uniqueEmail('grpui-a'), pw, 'MENTEE', `Ring Alpha ${stamp}`, org.id);
    const b = await seedUser(uniqueEmail('grpui-b'), pw, 'MENTEE', `Ring Beta ${stamp}`, org.id);
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/mentorship');

    await page.getByTestId('group-create-open').click();
    await page.getByTestId('group-mentor').selectOption(mentor.id);
    await page.getByTestId(`group-mentee-${a.id}`).check();
    await page.getByTestId(`group-mentee-${b.id}`).check();
    await page.getByTestId('group-create-submit').click();

    await expect.poll(() => prisma.mentorshipRelation.count({ where: { orgId: org.id, relationType: 'GROUP' } })).toBe(1);
    const group = await prisma.mentorshipRelation.findFirstOrThrow({ where: { orgId: org.id } });
    await expect(page.getByTestId(`relation-type-${group.id}`)).toBeVisible();
    await page.getByTestId(`group-members-toggle-${group.id}`).click();
    const members = page.getByTestId(`group-members-${group.id}`);
    await expect(members.getByText(`Ring Beta ${stamp}`)).toBeVisible();
    await expect(members.getByText(`Ring Mentor ${stamp}`)).toBeVisible();
  } finally {
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
