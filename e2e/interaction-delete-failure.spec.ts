import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1355: the delete handler never read the response, so a 403/404/500 still
// produced the green "Interaction deleted" toast while the row stayed on the
// page. In a CRM that is worse than losing the record — the mentor believes
// something happened that did not. The failure path must say so, in the
// mentor's own language (the routes' 4xx bodies are hardcoded English), and the
// list must end up showing whatever the server actually kept.
test('a rejected interaction delete shows an error, not a "deleted" toast', async ({ page }) => {
  const mentorEmail = uniqueEmail('idf-mentor');
  const menteeEmail = uniqueEmail('idf-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'IDF Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'IDF Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  const interaction = await prisma.interactionLog.create({
    data: {
      relationId: rel.id,
      date: new Date('2026-01-15'),
      type: 'Meeting',
      notes: 'Undeletable kickoff meeting',
    },
  });
  const second = await prisma.interactionLog.create({
    data: {
      relationId: rel.id,
      date: new Date('2026-01-16'),
      type: 'Meeting',
      notes: 'Ordinary follow-up meeting',
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);

    const row = page.getByTestId('interaction-list').getByText('Undeletable kickoff meeting');
    const other = page.getByTestId('interaction-list').getByText('Ordinary follow-up meeting');
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Force the failure the user cannot otherwise provoke: the endpoint answers
    // 403 for a relation that is not the caller's, which a signed-in mentor on
    // their own mentee never hits.
    await page.route(`**/api/interactions/${interaction.id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Forbidden' }),
      });
    });

    await page.getByTestId(`interaction-delete-${interaction.id}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();

    // The reason is stated from the dictionary, not echoed from the server —
    // the route's body says the English literal "Forbidden", which a Turkish or
    // German mentor must never be shown.
    await expect(
      page.getByRole('status').filter({ hasText: 'You are not allowed to do that.' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Forbidden' })).toHaveCount(0);
    // …and the lie is gone.
    await expect(page.getByRole('status').filter({ hasText: 'Interaction deleted' })).toHaveCount(0);
    // The record is still on the page, matching what the server kept.
    await expect(row).toBeVisible();
    expect(await prisma.interactionLog.count({ where: { id: interaction.id } })).toBe(1);

    await page.unroute(`**/api/interactions/${interaction.id}`);

    // A row the server no longer has: deleted from somewhere else while this
    // page was open. The delete answers 404, so it is honest to say the record
    // is gone — and the list must converge on that rather than keep rendering a
    // phantom row that 404s on every retry.
    await prisma.interactionLog.delete({ where: { id: interaction.id } });
    await page.getByTestId(`interaction-delete-${interaction.id}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'no longer there' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveCount(0);

    // A real delete still behaves exactly as before.
    await page.getByTestId(`interaction-delete-${second.id}`).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Interaction deleted' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(other).toHaveCount(0);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
