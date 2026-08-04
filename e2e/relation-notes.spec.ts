import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor can add a private note on a mentee; the note stays mentor-only', async ({ page }) => {
  const mentorEmail = uniqueEmail('note-mentor');
  const menteeEmail = uniqueEmail('note-mentee');
  const outsiderMentorEmail = uniqueEmail('note-outsider-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Note Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Note Mentee');
  const outsiderMentor = await seedUser(outsiderMentorEmail, 'x', 'MENTOR', 'Outsider Mentor');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });

  try {
    // Mentor adds a private note.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    await page.goto(`/mentor/mentees/${rel.id}`);
    const panel = page.getByTestId('relation-notes-panel');
    await expect(panel.getByText(/Private notes/i)).toBeVisible({ timeout: 10_000 });
    // Scoped to this panel — the page has several other <textarea> fields
    // (interaction log, evaluation, Q&A) an unscoped fill would hit instead.
    await panel.locator('textarea').fill('Strong technical fit, a bit shy in meetings — check in 1:1.');
    await panel.getByRole('button', { name: /^Add note$/i }).click();
    await expect(panel.getByText('Strong technical fit, a bit shy in meetings — check in 1:1.')).toBeVisible({ timeout: 10_000 });

    // IDOR: an unrelated mentor cannot read notes on this relation.
    await signInAsFreshUser(page, outsiderMentorEmail, 'x', '/mentor');
    const outsiderRes = await page.request.get(`/api/relation-notes?relationId=${rel.id}`);
    expect(outsiderRes.status()).toBe(403);

    // The mentee is never exposed to the note, even via the API directly.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    const menteeApiRes = await page.request.get(`/api/relation-notes?relationId=${rel.id}`);
    expect(menteeApiRes.status()).toBe(403);
  } finally {
    await prisma.relationNote.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(outsiderMentorEmail);
  }
});
