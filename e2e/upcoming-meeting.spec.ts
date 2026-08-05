import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * "A meeting is about to start / is running now" (#51 follow-up).
 *
 * The dashboard announces it half an hour ahead; the header's join pill appears
 * only while it is actually running (assumed 60 minutes). Both read one endpoint,
 * so the three cases below are the whole contract: soon, now, and neither.
 */

const password = 'UpcomingPass123!';
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60 * 1000);

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Upcoming Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Upcoming Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

async function seedMeeting(relationId: string, scheduledAt: Date, title: string) {
  return prisma.meeting.create({
    data: {
      relationId,
      title,
      scheduledAt,
      meetLink: 'https://meet.example.com/upcoming-room',
      rsvpToken: `e2e-${Math.random().toString(36).slice(2)}`,
      createdById: 'e2e',
    },
  });
}

test('a meeting starting within half an hour shows on the dashboard, without the header pill', { tag: '@smoke' }, async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('soon');
  await seedMeeting(relation.id, minutesFromNow(20), 'Kickoff soon');

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const banner = page.getByTestId('upcoming-meeting-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('Kickoff soon');
    await expect(banner.getByTestId('upcoming-meeting-join')).toHaveAttribute(
      'href',
      'https://meet.example.com/upcoming-room'
    );
    // Not started yet → no permanent join pill in the header.
    await expect(page.getByTestId('join-meeting-pill')).toHaveCount(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('while a meeting is running the header carries a join link on every page', { tag: '@smoke' }, async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('now');
  // Started 10 minutes ago: inside the 60-minute window.
  await seedMeeting(relation.id, minutesFromNow(-10), 'Running now');

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await expect(page.getByTestId('upcoming-meeting-banner')).toContainText('Running now', { timeout: 20_000 });
    // The shell renders the pill twice — mobile top bar and desktop strip — so
    // target the one visible at this viewport, like the messages icon spec does.
    const pill = page.locator('[data-testid="join-meeting-pill"]:visible').first();
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toHaveAttribute('href', 'https://meet.example.com/upcoming-room');

    // The pill lives in the app shell, so it follows you off the dashboard.
    await gotoSettled(page, '/mentor/mentees');
    await expect(page.locator('[data-testid="join-meeting-pill"]:visible').first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a meeting outside the window shows nothing at all', async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('quiet');
  // Too far ahead for the banner, and long over for the pill.
  await seedMeeting(relation.id, minutesFromNow(180), 'Later today');
  await seedMeeting(relation.id, minutesFromNow(-180), 'This morning');

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const res = await page.request.get('/api/meetings/upcoming');
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).meeting).toBeNull();
    await expect(page.getByTestId('upcoming-meeting-banner')).toHaveCount(0);
    await expect(page.getByTestId('join-meeting-pill')).toHaveCount(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('the recurring project meeting reaches a member with no mentorship for it', async ({ page }) => {
  const ownerEmail = uniqueEmail('series-owner');
  const memberEmail = uniqueEmail('series-member');
  const owner = await seedUser(ownerEmail, password, 'MENTOR', 'Series Owner');
  const member = await seedUser(memberEmail, password, 'MENTEE', 'Series Member');

  const project = await prisma.project.create({
    data: {
      name: 'Series Project',
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

  // A rule whose next occurrence is 15 minutes out. Wall-clock times are stored
  // as UTC by the series generator, so build the expectation the same way.
  const target = minutesFromNow(15);
  const hhmm = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;
  const series = await prisma.meetingSeries.create({
    data: {
      projectId: project.id,
      title: 'Weekly project call',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: hhmm,
      fixedLink: 'https://meet.example.com/series-room',
      createdById: owner.id,
    },
  });

  try {
    // The member has no MentorshipRelation at all — membership is the only link.
    await signInAndSettle(page, memberEmail, password, '/portal');
    const banner = page.getByTestId('upcoming-meeting-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('Weekly project call');
    await expect(banner).toContainText('Series Project');
  } finally {
    await prisma.meetingSeriesReminder.deleteMany({ where: { seriesId: series.id } });
    await prisma.meetingSeries.delete({ where: { id: series.id } }).catch(() => {});
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(ownerEmail);
    await cleanupByEmail(memberEmail);
  }
});
