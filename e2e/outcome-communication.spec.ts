import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #830 — negative-outcome communication.
//
// The distinction the whole feature turns on: INTERNSHIP_FOUND_ELSEWHERE_800
// means the student FOUND an internship. It is a success, and it must never be
// worded like the rejection that INTERNSHIP_DROPPED_460 is. The portal is where
// the mentee reads it, so that is where it is asserted.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string, stage: 'INTERNSHIP_DROPPED_460' | 'INTERNSHIP_FOUND_ELSEWHERE_800') {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Outcome Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Outcome Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: stage },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

test('a dropped candidate is told where they stand, with concrete next steps — and no celebration banner', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail } = await seedPair('outcome-drop', 'INTERNSHIP_DROPPED_460');
  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    const outcome = page.getByTestId('journey-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toContainText('Where things stand');
    // Something to do next — the difference between an ending and a dead end.
    await expect(outcome.getByRole('link', { name: /Update your profile/i })).toBeVisible();
    await expect(outcome.getByRole('link', { name: /Write to your mentor/i })).toBeVisible();
    // A rejection must not be crowned with "🎉 Milestone reached!".
    await expect(page.getByText('Milestone reached')).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('finding an internship elsewhere reads as a success, not a rejection', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail } = await seedPair('outcome-else', 'INTERNSHIP_FOUND_ELSEWHERE_800');
  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    const outcome = page.getByTestId('journey-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toContainText('You found an internship');
    await expect(outcome).toContainText('Congratulations');
    // None of the rejection wording leaks into the celebratory case.
    await expect(outcome).not.toContainText('Where things stand');
    await expect(outcome).not.toContainText('did not end in a placement');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('moving a mentee to an outcome stage hands the mentor a prefilled draft — and sends nothing on its own', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('outcome-draft-mentor');
  const menteeEmail = uniqueEmail('outcome-draft-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Draft Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Draft Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    const res = await page.request.put(`/api/mentorship/${relation.id}`, {
      // Moving into a negative stage requires a drop-off reason (#810).
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'SKILL_MISMATCH' },
    });
    expect(res.ok()).toBeTruthy();

    // The mentor is told to write, and pointed at the composer with the right
    // template — the "preview + human approval" step the feature is built on.
    const notif = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.link).toContain(`/mentor/email?relation=${relation.id}`);
    expect(notif?.link).toContain('template=outcomeNoMatch');

    // The mentee hears about it in their own words, not as a tracker row.
    const menteeNotif = await prisma.notification.findFirst({
      where: { userId: mentee.id, type: 'outcome.noMatch' },
    });
    expect(menteeNotif).not.toBeNull();
    const generic = await prisma.notification.count({ where: { userId: mentee.id, type: 'stage.changed' } });
    expect(generic).toBe(0);

    // Auto-send is off by default: nothing was emailed, so no Email interaction
    // was logged on the relation.
    const emails = await prisma.interactionLog.count({ where: { relationId: relation.id, type: 'Email' } });
    expect(emails).toBe(0);

    // Following the link lands on a composer with the recipient ticked and the
    // outcome template already in the body.
    await page.goto(notif!.link!);
    const body = page.locator('textarea').first();
    await expect(body).toHaveValue(/could not find a placement/i, { timeout: 20_000 });
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a candidate who accepted elsewhere is congratulated, not let down gently', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('outcome-reason-mentor');
  const menteeEmail = uniqueEmail('outcome-reason-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Reason Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Reason Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    // Same negative stage as the rejection case — only the reason differs, and
    // the reason is what says this was somebody taking a better offer (#810).
    const res = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'ACCEPTED_ELSEWHERE' },
    });
    expect(res.ok()).toBeTruthy();

    const notif = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif?.link).toContain('template=outcomePlacedElsewhere');
    const menteeNotif = await prisma.notification.findFirst({
      where: { userId: mentee.id, type: 'outcome.placedElsewhere' },
    });
    expect(menteeNotif).not.toBeNull();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
