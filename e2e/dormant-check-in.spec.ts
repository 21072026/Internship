import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { sweepDormantFirstContacts, DORMANT_GRACE_DAYS } from '../src/lib/dormantFirstContact';
import { sendDormantCheckIns, DORMANT_MAX_NUDGES } from '../src/services/emailService';

test.afterAll(async () => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// #1508 — the flag, and the two check-ins it drives.
test('the sweep flags dormant first contacts and drives exactly two check-ins', async () => {
  const mentorEmail = uniqueEmail('checkin-mentor');
  const dormantEmail = uniqueEmail('checkin-dormant');
  const freshEmail = uniqueEmail('checkin-fresh');
  try {
    const mentor = await seedUser(mentorEmail, 'CheckInPass123', 'MENTOR', 'Check-in Mentor');
    const mentee = await seedUser(dormantEmail, 'CheckInPass123', 'MENTEE', 'Silent Mentee');
    const fresh = await seedUser(freshEmail, 'CheckInPass123', 'MENTEE', 'Just Messaged Mentee');

    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    await prisma.interactionLog.create({
      data: { relationId: relation.id, date: daysAgo(60), notes: 'Welcome email', type: 'Email' },
    });
    // Written to two days ago: silence that recent is not an answer yet, so it
    // must not be flagged — the badge would be a lie and the check-in rude.
    const recent = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: fresh.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    await prisma.interactionLog.create({
      data: { relationId: recent.id, date: daysAgo(2), notes: 'Welcome email', type: 'Email' },
    });

    const swept = await sweepDormantFirstContacts();
    expect(swept.flagged).toBeGreaterThanOrEqual(1);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantSince).not.toBeNull();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: recent.id } })).dormantSince).toBeNull();
    // The grace period is what separates the two — keep them on either side of it.
    expect(DORMANT_GRACE_DAYS).toBeGreaterThan(2);

    // First check-in goes out; a second run the same day must not follow it.
    await sendDormantCheckIns();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantNudgeCount).toBe(1);
    await sendDormantCheckIns();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantNudgeCount).toBe(1);

    // A month later the final one goes out — and that is the whole budget.
    await sendDormantCheckIns(new Date(Date.now() + 32 * DAY));
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantNudgeCount).toBe(DORMANT_MAX_NUDGES);
    await sendDormantCheckIns(new Date(Date.now() + 400 * DAY));
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantNudgeCount).toBe(DORMANT_MAX_NUDGES);

    // The mentee finally answers: the flag and the whole nudge budget reset, so
    // a future silence is a new episode rather than a person already written off.
    await prisma.message.create({ data: { relationId: relation.id, senderId: mentee.id, body: 'Yes, still interested!' } });
    const cleared = await sweepDormantFirstContacts();
    expect(cleared.cleared).toBeGreaterThanOrEqual(1);
    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
    expect(after.dormantSince).toBeNull();
    expect(after.dormantNudgeCount).toBe(0);
    expect(after.dormantNudgeSentAt).toBeNull();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(dormantEmail);
    await cleanupByEmail(freshEmail);
  }
});

// An opted-out mentee must not silently burn their two-nudge budget: opting
// back in later has to buy them the check-in, not permanent silence.
test('an opted-out mentee is skipped without spending a nudge', async () => {
  const mentorEmail = uniqueEmail('optout-mentor');
  const menteeEmail = uniqueEmail('optout-mentee');
  try {
    const mentor = await seedUser(mentorEmail, 'CheckInPass123', 'MENTOR', 'Opt-out Mentor');
    const mentee = await seedUser(menteeEmail, 'CheckInPass123', 'MENTEE', 'Opted Out Mentee');
    await prisma.user.update({ where: { id: mentee.id }, data: { emailNotifications: false } });
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    await prisma.interactionLog.create({
      data: { relationId: relation.id, date: daysAgo(90), notes: 'Welcome email', type: 'Email' },
    });

    await sweepDormantFirstContacts();
    await sendDormantCheckIns();
    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
    expect(after.dormantSince).not.toBeNull();
    expect(after.dormantNudgeCount).toBe(0);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// The mentee list hides dormant relations by default — that is the point — so
// the toggle that brings them back has to be on screen and has to work.
test('the mentee list hides dormant relations behind a toggle that counts them', async ({ page }) => {
  const password = 'DormantList123';
  const mentorEmail = uniqueEmail('dormant-list-mentor');
  const dormantEmail = uniqueEmail('dormant-list-quiet');
  const activeEmail = uniqueEmail('dormant-list-active');
  try {
    const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Dormant List Mentor');
    const quiet = await seedUser(dormantEmail, password, 'MENTEE', 'Quiet Applicant');
    const active = await seedUser(activeEmail, password, 'MENTEE', 'Talking Applicant');
    const dormantRelation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: quiet.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100', dormantSince: daysAgo(30), dormantNudgeCount: 2 },
    });
    const activeRelation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: active.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });

    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await page.goto('/mentor/mentees');
    await expect(page.getByText('Talking Applicant')).toBeVisible();
    await expect(page.getByText('Quiet Applicant')).toHaveCount(0);
    await expect(page.getByTestId(`dormant-badge-${dormantRelation.id}`)).toHaveCount(0);

    await page.getByTestId('toggle-dormant-mentees').click();
    await expect(page.getByText('Quiet Applicant')).toBeVisible();
    await expect(page.getByTestId(`dormant-badge-${dormantRelation.id}`)).toBeVisible();
    await expect(page.getByTestId(`dormant-badge-${activeRelation.id}`)).toHaveCount(0);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(dormantEmail);
    await cleanupByEmail(activeEmail);
  }
});
