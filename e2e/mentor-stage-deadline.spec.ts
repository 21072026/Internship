import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1373: the attention queue's "overdue" reason reads stageDeadline, which only
// the admin screen could write. The mentor now sets it on the mentee detail
// page through the existing PUT; another mentor's relation stays 403, and the
// company stays an admin decision (#2613).
test('a mentor sets a stage deadline; a past one shows overdue on the page and in the queue', async ({ page, playwright }, info) => {
  const mentorEmail = uniqueEmail('sd-mentor');
  const otherEmail = uniqueEmail('sd-other');
  const menteeEmail = uniqueEmail('sd-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'SD Mentor');
  await seedUser(otherEmail, 'MentorPass123', 'MENTOR', 'SD Other');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'SD Deadline Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const other = await playwright.request.newContext({ baseURL: info.project.use.baseURL });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    const input = page.getByTestId('stage-deadline-input');
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('stage-deadline-overdue')).toHaveCount(0);

    await input.fill('2020-01-15');
    await input.blur();
    await expect(page.getByTestId('stage-deadline-overdue')).toBeVisible({ timeout: 30_000 });
    const saved = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(saved.stageDeadline?.toISOString().slice(0, 10)).toBe('2020-01-15');

    await gotoSettled(page, '/mentor');
    const row = page.getByTestId('attention-queue').getByRole('link', { name: /SD Deadline Mentee/ });
    await expect(row.getByText(/Stage overdue/i)).toBeVisible({ timeout: 15_000 });

    // Clearing it removes the warning.
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    await input.fill('');
    await input.blur();
    await expect(page.getByTestId('stage-deadline-overdue')).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } })).stageDeadline)
      .toBeNull();

    // Another mentor may not write it (existing rule, kept).
    expect((await signInViaApi(other, otherEmail, 'MentorPass123')).ok).toBe(true);
    expect((await other.put(`/api/mentorship/${rel.id}`, { data: { stageDeadline: '2020-01-01' } })).status()).toBe(403);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } })).stageDeadline).toBeNull();
  } finally {
    await other.dispose();
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    for (const e of [mentorEmail, otherEmail, menteeEmail]) await cleanupByEmail(e);
  }
});
