import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1408 — a mentorship marked COMPLETED used to empty the mentee's portal: every
// page asked for `status: 'ACTIVE'` only, so the mentor, company, stage bar,
// goals and question history disappeared and the portal said "no mentor assigned
// yet — an admin will assign you one once your profile is reviewed". Finishing
// the programme is its success case; this spec pins the archive behaviour that
// replaced it, and the server-side half of the read-only rule.

test.afterAll(async () => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;

test('a completed mentorship reads as an archive, not as "no mentor yet"', async ({ page }) => {
  const password = 'ArchivedPortal123';
  const mentorEmail = uniqueEmail('archived-mentor');
  const menteeEmail = uniqueEmail('archived-mentee');
  let relationId = '';

  try {
    const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Archived Mentor');
    const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Archived Mentee');
    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id,
        menteeId: mentee.id,
        status: 'COMPLETED',
        pipelineStatus: 'INTERNSHIP_COMPLETED_490',
        startDate: new Date(Date.now() - 120 * DAY),
        completedAt: new Date(Date.now() - 5 * DAY),
      },
    });
    relationId = relation.id;
    // Goals cascade with the relation, so no extra teardown for this row.
    const goal = await prisma.goal.create({
      data: { relationId, title: 'Ship the final report', status: 'OPEN', createdByRole: 'MENTOR' },
    });

    await signInAndSettle(page, menteeEmail, password, '/portal');

    // The dashboard shows the mentorship it used to hide.
    await expect(page.getByTestId('mentorship-archived-notice')).toBeVisible();
    await expect(page.getByText('Archived Mentor').first()).toBeVisible();

    // The journey page keeps the stage bar and the full mentor card.
    await page.goto('/portal/journey');
    await expect(page.getByTestId('mentorship-archived-notice')).toBeVisible();
    await expect(page.getByText('Archived Mentor').first()).toBeVisible();
    await expect(page.getByText('490 · Internship completed').first()).toBeVisible();

    // Goals stay readable; the add form is gone. `input[type="date"]` is the
    // add-goal due date and only exists inside that form.
    await page.goto('/portal/goals');
    await expect(page.getByTestId(`goal-${goal.id}`)).toBeVisible();
    await expect(page.locator('input[type="date"]')).toHaveCount(0);

    // Questions and meeting requests are closed: no compose textarea and no
    // proposed-time input on the whole page.
    await page.goto('/portal/requests');
    await expect(page.getByTestId('mentorship-archived-notice')).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);

    // The server enforces the same rule, so hiding the forms is not the only
    // thing standing between a finished mentorship and a new write.
    for (const [url, body] of [
      ['/api/questions', { relationId, question: 'Is this still open?' }],
      ['/api/meeting-requests', { relationId, topic: 'One more session', proposedAt: '2030-01-01T10:00' }],
      ['/api/goals', { relationId, title: 'A goal after the end' }],
    ] as const) {
      const res = await page.request.post(url, { data: body });
      expect(res.status(), `${url} must refuse a mentee write on a completed mentorship`).toBe(409);
      expect((await res.json()).code).toBe('inactive_relation');
    }
    const patched = await page.request.patch(`/api/goals/${goal.id}`, { data: { status: 'DONE' } });
    expect(patched.status()).toBe(409);
    expect(await prisma.goal.findUnique({ where: { id: goal.id } }).then((g) => g?.status)).toBe('OPEN');

    // Reopening the mentorship restores everything, so the archive is a view of
    // the status and not a one-way door.
    await prisma.mentorshipRelation.update({
      where: { id: relationId },
      data: { status: 'ACTIVE', completedAt: null },
    });
    await page.goto('/portal/requests');
    await expect(page.getByTestId('mentorship-archived-notice')).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(1);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
