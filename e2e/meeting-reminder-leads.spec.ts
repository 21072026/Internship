import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { sendMeetingReminders } from '../src/services/emailService';

// Meeting reminder lead times (#1636), run in-process against the test DB: a
// programme with a 30-minute lead and the default org next to it remind at
// different moments; a meeting's own lead overrides its programme; 0 means no
// reminder; a second sweep never reminds twice.

const PASSWORD = 'LeadPass123!';
const emails: string[] = [];
let orgId = '';
let cohortId = '';
const relationIds: string[] = [];

async function pair(prefix: string, cohort: string | null) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  emails.push(mentorEmail, menteeEmail);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', `${prefix} Mentee`);
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const rel = await prisma.mentorshipRelation.create({ data: { orgId, mentorId: mentor.id, menteeId: mentee.id, cohortId: cohort } });
  relationIds.push(rel.id);
  return { id: rel.id, mentorId: mentor.id };
}

const meeting = (rel: { id: string; mentorId: string }, minutesAhead: number, reminderLeadMinutes: number | null = null) =>
  prisma.meeting.create({
    data: {
      relationId: rel.id,
      createdById: rel.mentorId,
      title: `Lead test ${minutesAhead}`,
      scheduledAt: new Date(Date.now() + minutesAhead * 60_000),
      reminderLeadMinutes,
      rsvpToken: randomBytes(16).toString('hex'),
    },
    select: { id: true },
  });

const state = (id: string) => prisma.meeting.findUniqueOrThrow({ where: { id }, select: { remindedLeads: true, reminderSentAt: true } });

test.beforeAll(async () => {
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Leads ${s}`, slug: `leads-${s}` } })).id;
  cohortId = (await prisma.cohort.create({ data: { orgId, name: `Bootcamp ${s}` } })).id;
  await prisma.setting.create({ data: { orgId, programId: cohortId, key: 'meetingReminderLeadsMinutes', value: '30' } });
});

test.afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { relationId: { in: relationIds } } });
  await prisma.notification.deleteMany({ where: { user: { orgId } } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relationIds } } });
  await prisma.setting.deleteMany({ where: { orgId } });
  for (const e of emails) await cleanupByEmail(e);
  await prisma.cohort.deleteMany({ where: { id: cohortId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

test('a programme lead, the default lead, a per-meeting override and "none"', async () => {
  test.setTimeout(120_000);
  const bootcamp = await pair('lead-bootcamp', cohortId);
  const plain = await pair('lead-plain', null);

  const bootcampAt45 = await meeting(bootcamp, 45); // programme lead 30: not yet
  const bootcampAt25 = await meeting(bootcamp, 25); // inside 30: due
  const plainAt45 = await meeting(plain, 45); // default lead 60: due
  const overrideDay = await meeting(bootcamp, 1430, 1440); // its own lead: due
  const none = await meeting(plain, 10, 0); // asked for no reminder

  await sendMeetingReminders();

  expect(await state(bootcampAt45.id)).toMatchObject({ remindedLeads: null, reminderSentAt: null });
  expect((await state(bootcampAt25.id)).remindedLeads).toBe('30');
  expect((await state(plainAt45.id)).remindedLeads).toBe('60');
  expect((await state(plainAt45.id)).reminderSentAt).not.toBeNull();
  expect((await state(overrideDay.id)).remindedLeads).toBe('1440');
  expect(await state(none.id)).toMatchObject({ remindedLeads: null, reminderSentAt: null });

  // A second sweep reminds nobody twice.
  const before = await prisma.notification.count({ where: { user: { orgId }, type: 'meeting_reminder.startingSoon' } });
  await sendMeetingReminders();
  const after = await prisma.notification.count({ where: { user: { orgId }, type: 'meeting_reminder.startingSoon' } });
  expect(after).toBe(before);
  // Three meetings reminded, two participants each.
  expect(before).toBe(6);
});
