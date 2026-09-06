import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1354: the mentor's "log an interaction" form used to hardcode an English
// three-item type menu (Meeting / Feedback / Email), so a Turkish mentor saw
// English labels and could not record a phone call or a WhatsApp exchange at
// all — even though the API, the list filter and the badge already knew all
// five types.
test('interaction type menu is localized and offers all five channels', async ({ page }) => {
  const mentorEmail = uniqueEmail('iti-mentor');
  const menteeEmail = uniqueEmail('iti-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'ITI Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'ITI Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  const notes = `Telefonda staj planini konustuk ${Date.now().toString(36)}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Switch the UI to Turkish, then open the log form on the mentee detail page.
    await page.goto(`/mentor/mentees/${relation.id}`);
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.reload();

    await page.getByRole('button', { name: 'Kayıt Ekle' }).click();
    const form = page.getByTestId('interaction-log-form');
    const typeSelect = form.locator('select');

    // Every type the API accepts, in Turkish — not the old English three.
    await expect(typeSelect.locator('option')).toHaveText([
      'Toplantı',
      'Geri bildirim',
      'E-posta',
      'Arama',
      'WhatsApp',
    ]);
    // The keys stay English (they are the Prisma enum values).
    const optionValues = await typeSelect
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(optionValues).toEqual(['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp']);

    // The notes placeholder is translated too.
    await expect(form.getByTestId('interaction-log-notes')).toHaveAttribute(
      'placeholder',
      'Neler konuşuldu...'
    );

    // The date/notes guard speaks Turkish rather than "Date and notes are required".
    await form.getByRole('button', { name: 'Kaydet' }).click();
    await expect(form.getByText('Tarih ve not zorunludur')).toBeVisible();

    // A Call log can actually be created from the form and comes back with the
    // localized badge.
    await typeSelect.selectOption('Call');
    await form.getByTestId('interaction-log-date').fill('2026-02-03');
    await form.getByTestId('interaction-log-notes').fill(notes);
    await form.getByRole('button', { name: 'Kaydet' }).click();

    await expect(page.getByText(notes)).toBeVisible({ timeout: 10_000 });
    // The saved log carries the Turkish "Arama" badge (no filter button by that
    // name exists on the detail page, so this can only be the badge).
    await expect(page.getByText('Arama', { exact: true })).toBeVisible();
    const saved = await prisma.interactionLog.findFirst({ where: { relationId: relation.id } });
    expect(saved?.type).toBe('Call');

    // …and the aggregate list shows it under the Turkish "Arama" filter.
    await page.goto('/mentor/interactions');
    await expect(page.getByText(notes)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Arama', exact: true }).click();
    await expect(page.getByText(notes)).toBeVisible();
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
