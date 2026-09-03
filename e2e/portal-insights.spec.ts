import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1915 — the activity report exists about the mentee and used to be readable
// only by their mentor and an admin. `/portal/insights` is their own copy of
// it. What this spec pins: the page renders for a real mentee, the
// consent-gated block says "tracking is off" instead of showing zeros, turning
// the consent on swaps in the real numbers, and the API behind it has no mentee
// id to tamper with.

test.afterAll(async () => prisma.$disconnect());

test('a mentee reads their own activity summary, with an honest no-consent state', async ({ page }) => {
  const password = 'PortalInsights123';
  const mentorEmail = uniqueEmail('insights-mentor');
  const menteeEmail = uniqueEmail('insights-mentee');

  try {
    const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Insights Mentor');
    const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Insights Mentee');
    // A mentee with no relation is bounced out of the portal shell (#1412), so
    // the mentorship is part of the fixture, not decoration.
    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id,
        menteeId: mentee.id,
        status: 'ACTIVE',
        pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450',
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });
    // One completed goal so the mentorship block has a non-zero number to show;
    // goals cascade with the relation, so there is no extra teardown.
    await prisma.goal.create({
      data: {
        relationId: relation.id,
        title: 'Finish the onboarding checklist',
        status: 'DONE',
        completedAt: new Date(),
        createdByRole: 'MENTOR',
      },
    });

    await signInAndSettle(page, menteeEmail, password, '/portal');
    await page.goto('/portal/insights');

    await expect(page.getByTestId('portal-insights')).toBeVisible();
    // Nothing was tracked and no consent was given: the page says so.
    await expect(page.getByTestId('portal-insights-no-consent')).toBeVisible();
    await expect(page.getByTestId('portal-insights-tracking')).toHaveCount(0);

    // The route is a self-view: it answers for the caller and takes no id, so a
    // pasted-in one is simply ignored rather than honoured.
    const own = await page.request.get('/api/portal/insights?days=7');
    expect(own.status()).toBe(200);
    const body = await own.json();
    expect(body.activity.menteeId).toBe(mentee.id);
    expect(body.trackingConsent).toBe(false);
    expect(body.activity.goalsCompleted).toBe(1);

    const spoofed = await page.request.get(`/api/portal/insights?days=7&menteeId=${mentor.id}&userId=${mentor.id}`);
    expect(spoofed.status()).toBe(200);
    expect((await spoofed.json()).activity.menteeId).toBe(mentee.id);

    // Granting the consent turns the tracking block on — same page, no plan and
    // no upgrade step in between.
    await prisma.userConsent.create({
      data: { userId: mentee.id, type: 'ACTIVITY_TRACKING', grantedAt: new Date() },
    });
    await page.reload();
    await expect(page.getByTestId('portal-insights-tracking')).toBeVisible();
    await expect(page.getByTestId('portal-insights-no-consent')).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
