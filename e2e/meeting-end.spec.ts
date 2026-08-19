import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { E2E_JAAS_WEBHOOK_SECRET } from '../playwright.config';

/**
 * "The meeting is over" (participant-declared) + live room info.
 *
 * The dashboard strip used to sit on "in progress" for the whole assumed hour
 * even when everyone had hung up after twenty minutes. Now any participant can
 * declare the meeting over — POST /api/meetings/[id]/end — and the strip
 * disappears for *everyone* (the shared endpoint stops returning it). And when
 * the JaaS webhook feed is configured, the strip shows who is actually in the
 * room (/api/webhooks/jaas → MeetingRoomState).
 */

const password = 'MeetingEndPass123!';
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60 * 1000);

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'End Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'End Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

async function seedMeeting(relationId: string, scheduledAt: Date, title: string, meetLink?: string) {
  return prisma.meeting.create({
    data: {
      relationId,
      title,
      scheduledAt,
      meetLink: meetLink ?? 'https://meet.example.com/end-room',
      rsvpToken: `e2e-${Math.random().toString(36).slice(2)}`,
      createdById: 'e2e',
    },
  });
}

test('any participant can declare a running meeting over — and it is gone for everyone', { tag: '@smoke' }, async ({ page }) => {
  const { mentorEmail, menteeEmail, mentee, relation } = await seedPair('endnow');
  const meeting = await seedMeeting(relation.id, minutesFromNow(-10), 'Retro running');

  try {
    // The mentee (a participant, not the organizer) ends it from the banner.
    await signInAndSettle(page, menteeEmail, password, '/portal');
    const banner = page.getByTestId('upcoming-meeting-banner');
    await expect(banner).toContainText('Retro running', { timeout: 20_000 });

    page.once('dialog', (dialog) => void dialog.accept());
    await banner.getByTestId('upcoming-meeting-end').click();
    // The hook refreshes right after the POST — the strip vanishes without a reload.
    await expect(page.getByTestId('upcoming-meeting-banner')).toHaveCount(0, { timeout: 20_000 });

    // Hidden server-side for every participant, not just the marker's client.
    const res = await page.request.get('/api/meetings/upcoming');
    expect((await res.json()).meeting).toBeNull();
    const row = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    expect(row?.endedAt).not.toBeNull();
    expect(row?.endedById).toBe(mentee.id);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a meeting that has not started cannot be ended — no button, and the API refuses', async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('endsoon');
  const meeting = await seedMeeting(relation.id, minutesFromNow(20), 'Kickoff ahead');

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const banner = page.getByTestId('upcoming-meeting-banner');
    await expect(banner).toContainText('Kickoff ahead', { timeout: 20_000 });
    // Not ongoing → the end button is not offered…
    await expect(banner.getByTestId('upcoming-meeting-end')).toHaveCount(0);
    // …and hiding the button is not the authorization: the endpoint refuses too.
    const res = await page.request.post(`/api/meetings/${meeting.id}/end`);
    expect(res.status()).toBe(409);
    expect((await prisma.meeting.findUnique({ where: { id: meeting.id } }))?.endedAt).toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('ending one relation row of a multi-mentee meeting hides the siblings too', async ({ page }) => {
  // A relation-context meeting invites N relations as N Meeting rows sharing
  // one room link — ending it as one mentee must end it for the other as well.
  const { mentorEmail, menteeEmail, relation } = await seedPair('endsib');
  const otherEmail = uniqueEmail('endsib-mentee2');
  const other = await seedUser(otherEmail, password, 'MENTEE', 'End Sibling');
  const mentor = await prisma.user.findUnique({ where: { email: mentorEmail } });
  const relation2 = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor!.id, menteeId: other.id },
  });
  const startedAt = minutesFromNow(-5);
  const sharedLink = `https://meet.example.com/shared-${crypto.randomBytes(4).toString('hex')}`;
  await seedMeeting(relation.id, startedAt, 'Group sync', sharedLink);
  const siblingRow = await seedMeeting(relation2.id, startedAt, 'Group sync', sharedLink);

  try {
    await signInAndSettle(page, menteeEmail, password, '/portal');
    await expect(page.getByTestId('upcoming-meeting-banner')).toContainText('Group sync', { timeout: 20_000 });
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('upcoming-meeting-end').click();
    await expect(page.getByTestId('upcoming-meeting-banner')).toHaveCount(0, { timeout: 20_000 });

    const sibling = await prisma.meeting.findUnique({ where: { id: siblingRow.id } });
    expect(sibling?.endedAt).not.toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: { in: [relation.id, relation2.id] } } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherEmail);
  }
});

test('a recurring occurrence (no Meeting row) can be ended through its composite id', async ({ page }) => {
  const ownerEmail = uniqueEmail('endseries-owner');
  const memberEmail = uniqueEmail('endseries-member');
  const owner = await seedUser(ownerEmail, password, 'MENTOR', 'End Series Owner');
  const member = await seedUser(memberEmail, password, 'MENTEE', 'End Series Member');

  const project = await prisma.project.create({
    data: {
      name: 'End Series Project',
      ownerType: 'MENTOR',
      ownerUserId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: member.id, role: 'MENTEE', functionalRole: 'DEVELOPER' },
        ],
      },
    },
  });

  // A rule whose occurrence started 10 minutes ago, pinned to UTC like the
  // upcoming-meeting spec does since #1110.
  const target = minutesFromNow(-10);
  const hhmm = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;
  const series = await prisma.meetingSeries.create({
    data: {
      projectId: project.id,
      title: 'Daily standup',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: hhmm,
      timeZone: 'UTC',
      fixedLink: 'https://meet.example.com/end-series-room',
      createdById: owner.id,
    },
  });

  try {
    await signInAndSettle(page, memberEmail, password, '/portal');
    const before = await page.request.get('/api/meetings/upcoming');
    const upcoming = (await before.json()).meeting;
    expect(upcoming?.title).toBe('Daily standup');
    expect(String(upcoming.id)).toContain(':'); // synthesized: `<seriesId>:<ISO>`

    const end = await page.request.post(`/api/meetings/${encodeURIComponent(upcoming.id)}/end`);
    expect(end.ok()).toBeTruthy();

    const after = await page.request.get('/api/meetings/upcoming');
    expect((await after.json()).meeting).toBeNull();

    const mark = await prisma.meetingOccurrenceEnd.findFirst({ where: { seriesId: series.id } });
    expect(mark?.endedById).toBe(member.id);
  } finally {
    await prisma.meetingOccurrenceEnd.deleteMany({ where: { seriesId: series.id } });
    await prisma.meetingSeriesReminder.deleteMany({ where: { seriesId: series.id } });
    await prisma.meetingSeries.delete({ where: { id: series.id } }).catch(() => {});
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(ownerEmail);
    await cleanupByEmail(memberEmail);
  }
});

test('an outsider cannot end someone else’s meeting', async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('endforeign');
  const outsiderEmail = uniqueEmail('endforeign-outsider');
  await seedUser(outsiderEmail, password, 'MENTEE', 'End Outsider');
  const meeting = await seedMeeting(relation.id, minutesFromNow(-10), 'Private sync');

  try {
    await signInAndSettle(page, outsiderEmail, password, '/portal');
    const res = await page.request.post(`/api/meetings/${meeting.id}/end`);
    // Missing and not-yours answer the same, so the id space stays opaque.
    expect(res.status()).toBe(404);
    expect((await prisma.meeting.findUnique({ where: { id: meeting.id } }))?.endedAt).toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(outsiderEmail);
  }
});

test('the JaaS webhook feed puts live participants on the banner', async ({ page, request }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('endlive');
  const room = `InternshipCRM-e2e-${crypto.randomBytes(6).toString('hex')}`;
  const appId = 'vpaas-magic-cookie-e2etenant';
  await seedMeeting(relation.id, minutesFromNow(-10), 'Live check', `https://8x8.vc/${appId}/${room}`);

  const hook = (eventType: string, data?: Record<string, unknown>) =>
    request.post(`/api/webhooks/jaas?secret=${E2E_JAAS_WEBHOOK_SECRET}`, {
      data: { eventType, fqn: `${appId}/${room}`, data },
    });

  try {
    // The secret is the gate: without it nothing is accepted.
    const unauthorized = await request.post('/api/webhooks/jaas', {
      data: { eventType: 'ROOM_CREATED', fqn: `${appId}/${room}` },
    });
    expect(unauthorized.status()).toBe(401);

    expect((await hook('ROOM_CREATED')).ok()).toBeTruthy();
    expect((await hook('PARTICIPANT_JOINED', { participantId: 'p1', name: 'Ayşe Mentor' })).ok()).toBeTruthy();
    expect((await hook('PARTICIPANT_JOINED', { participantId: 'p2', name: 'Deniz Mentee' })).ok()).toBeTruthy();

    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const live = page.getByTestId('upcoming-meeting-live');
    await expect(live).toBeVisible({ timeout: 20_000 });
    await expect(live).toContainText('2');
    await expect(live).toContainText('Ayşe Mentor');

    // One leaves → the endpoint reports one; the room dying → nothing at all.
    expect((await hook('PARTICIPANT_LEFT', { participantId: 'p1' })).ok()).toBeTruthy();
    let res = await page.request.get('/api/meetings/upcoming');
    expect((await res.json()).meeting?.live).toEqual({ count: 1, names: ['Deniz Mentee'] });

    expect((await hook('ROOM_DESTROYED')).ok()).toBeTruthy();
    res = await page.request.get('/api/meetings/upcoming');
    expect((await res.json()).meeting?.live).toBeNull();
  } finally {
    await prisma.meetingRoomState.deleteMany({ where: { room } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
