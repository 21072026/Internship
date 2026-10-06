import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// The attendance step and the relation's rhythm (#2014, part 2).
//   • ending a pair meeting asks "who was there?" — everyone defaults to
//     attended, one tap marks the no-show, and the record lands;
//   • the relation record shows the rhythm, and the mentor can set it.

const PW = 'AttendanceUi123!';

test.describe('attendance UI', () => {
  const stamp = `${Date.now()}`;
  const mentor = uniqueEmail('maui-mentor');
  const mentee = uniqueEmail('maui-mentee');
  let orgId = '';
  let menteeId = '';
  let relationId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `MAUI Org ${stamp}`, slug: `maui-${stamp}` } })).id;
    const m = await seedUser(mentor, PW, 'MENTOR', `MAUI Mentor ${stamp}`, orgId);
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `MAUI Mentee ${stamp}`, orgId)).id;
    relationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId } })).id;
  });

  test.afterAll(async () => {
    await prisma.meetingAttendance.deleteMany({ where: { orgId } });
    await prisma.meeting.deleteMany({ where: { relationId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [mentor, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('ending a pair meeting asks who was there, and the answer is recorded', async ({ page }) => {
    const live = await prisma.meeting.create({
      data: { relationId, title: `Live ${stamp}`, scheduledAt: new Date(Date.now() - 10 * 60 * 1000), meetLink: `https://example.com/room-${stamp}`, rsvpToken: randomBytes(16).toString('hex'), createdById: (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).mentorId },
    });
    await signInAndSettle(page, mentor, PW, '/mentor');
    await expect(page.getByTestId('upcoming-meeting-banner')).toContainText(`Live ${stamp}`, { timeout: 20_000 });
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('upcoming-meeting-end').click();

    const step = page.getByTestId('attendance-step');
    await expect(step).toContainText(`MAUI Mentee ${stamp}`);
    // Everyone starts as attended; one tap marks the mentee absent.
    await expect(page.getByTestId(`attendance-${menteeId}-ATTENDED`)).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId(`attendance-${menteeId}-NO_SHOW`).click();
    await page.getByTestId('attendance-save').click();
    // On to the rating card, as before.
    await expect(page.getByTestId('meeting-feedback-card')).toBeVisible();

    const rows = await prisma.meetingAttendance.findMany({ where: { meetingId: live.id }, select: { userId: true, state: true } });
    expect(rows.find((r) => r.userId === menteeId)?.state).toBe('NO_SHOW');
    expect(rows).toHaveLength(2);
  });

  test('the relation record shows the rhythm, and the mentor sets it', async ({ page }) => {
    await prisma.meeting.create({
      data: { relationId, title: 'Earlier', scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), rsvpToken: randomBytes(16).toString('hex'), createdById: (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).mentorId },
    });
    await signInAndSettle(page, mentor, PW, '/mentor');
    await page.goto(`/mentor/mentees/${relationId}`);
    const panel = page.getByTestId('relation-cadence');
    await expect(panel.getByTestId('relation-cadence-status')).toHaveText('No rhythm agreed yet');
    await expect(panel.getByTestId('relation-cadence-last')).toContainText('3 days ago');
    await panel.getByTestId('relation-cadence-interval').selectOption('2');
    await expect(panel.getByTestId('relation-cadence-status')).toHaveText('On rhythm');
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).expectedMeetingIntervalWeeks).toBe(2);
    // The mentee cannot read (or set) it.
    await page.context().clearCookies();
    await signInAndSettle(page, mentee, PW, '/portal');
    expect((await page.request.get(`/api/mentorship/${relationId}/cadence`)).status()).toBe(403);
  });
});
