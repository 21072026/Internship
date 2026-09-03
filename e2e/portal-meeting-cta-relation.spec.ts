import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1423 — the empty meetings card's "ask your mentor for a meeting" link
// pointed at /portal/requests unconditionally, which has no request form for
// a mentee with no mentor relation (or an archived one) — a dead end. The
// link is now gated on UpcomingMeetings' `canRequestMeeting` prop
// (src/app/portal/page.tsx), computed from `relation && !isArchived`.
//
// Two separate tests (not one test switching users on the same page) so each
// gets its own fresh browser context — no session-cookie handoff to manage.

const password = 'PortalCta123!';
const noMentorEmail = uniqueEmail('cta-no-mentor');
const mentorEmail = uniqueEmail('cta-mentor');
const withMentorEmail = uniqueEmail('cta-with-mentor');

test.beforeAll(async () => {
  await seedUser(noMentorEmail, password, 'MENTEE', 'CTA No Mentor');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'CTA Mentor');
  const mentee = await seedUser(withMentorEmail, password, 'MENTEE', 'CTA With Mentor');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });
});

test.afterAll(async () => {
  await cleanupByEmail(noMentorEmail);
  await cleanupByEmail(withMentorEmail);
  await cleanupByEmail(mentorEmail);
  await prisma.$disconnect();
});

test('a mentee with no mentor relation does not see the meeting-request CTA', async ({ page }) => {
  await signInAndSettle(page, noMentorEmail, password, '/portal');
  const emptyCard = page.getByTestId('upcoming-meetings-empty');
  await expect(emptyCard).toBeVisible();
  await expect(emptyCard.getByRole('link')).toHaveCount(0);
  // The no-mentor hint now also says a mentor request can be sent, not just
  // "wait for an admin" (issue's 3rd acceptance criterion).
  await expect(page.getByText('You can send a mentor request')).toBeVisible();
});

test('a mentee with an active mentor relation still sees the meeting-request CTA', async ({ page }) => {
  await signInAndSettle(page, withMentorEmail, password, '/portal');
  const emptyCard = page.getByTestId('upcoming-meetings-empty');
  await expect(emptyCard).toBeVisible();
  await expect(emptyCard.getByRole('link', { name: 'Ask your mentor for a meeting' })).toBeVisible();
});
