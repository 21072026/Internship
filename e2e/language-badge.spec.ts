import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1164: every user has a preferredLanguage and the app speaks EN/TR/DE, but
// that preference was invisible on the screens where someone is about to write
// TO them — so people were being contacted in a language they had not chosen.
// The badge distinguishes "chose German" from "never chose" (which reads as the
// app default), because those are a fact and a guess respectively.
test('a person’s language preference is visible where you write to them', async ({ page }) => {
  const adminEmail = uniqueEmail('lang-admin');
  const germanEmail = uniqueEmail('lang-de');
  const unsetEmail = uniqueEmail('lang-unset');
  const pw = 'LangAdmin123';

  await seedUser(adminEmail, pw, 'ADMIN', 'Lang Admin');
  const german = await seedUser(germanEmail, 'x', 'MENTEE', 'Lang German Mentee');
  const unset = await seedUser(unsetEmail, 'x', 'MENTEE', 'Lang Unset Mentee');
  await prisma.user.update({ where: { id: german.id }, data: { preferredLanguage: 'de' } });
  // `unset` is deliberately left null — the seeder never sets one.

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto('/admin/candidates');

    // Scope to the desktop grid: the page renders every candidate twice (the
    // md:hidden mobile list is still in the DOM and strict mode counts it).
    const list = page.getByTestId('candidates-desktop-list');
    const germanCard = list.getByTestId(`candidate-card-${german.id}`);
    await expect(germanCard).toBeVisible({ timeout: 15_000 });
    await expect(germanCard.getByTestId('language-badge-de')).toBeVisible();
    await expect(germanCard.getByTestId('language-badge-de')).toHaveAttribute('data-language-set', 'true');

    // No preference: shown as the app default, and marked as *not* chosen.
    const unsetCard = list.getByTestId(`candidate-card-${unset.id}`);
    await expect(unsetCard.getByTestId('language-badge-en')).toHaveAttribute('data-language-set', 'false');
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(germanEmail);
    await cleanupByEmail(unsetEmail);
  }
});

// The bulk composer sends ONE body to everyone ticked, so it also has to say
// which languages that one body is about to land in.
test('the bulk email composer shows the language mix of the selected recipients', async ({ page }) => {
  const mentorEmail = uniqueEmail('langmix-mentor');
  const deEmail = uniqueEmail('langmix-de');
  const trEmail = uniqueEmail('langmix-tr');
  const pw = 'LangMentor123';

  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Lang Mix Mentor');
  const de = await seedUser(deEmail, 'x', 'MENTEE', 'Lang Mix German');
  const tr = await seedUser(trEmail, 'x', 'MENTEE', 'Lang Mix Turkish');
  await prisma.user.update({ where: { id: de.id }, data: { preferredLanguage: 'de' } });
  await prisma.user.update({ where: { id: tr.id }, data: { preferredLanguage: 'tr' } });
  await prisma.mentorshipRelation.createMany({
    data: [
      { mentorId: mentor.id, menteeId: de.id, status: 'ACTIVE' },
      { mentorId: mentor.id, menteeId: tr.id, status: 'ACTIVE' },
    ],
  });

  try {
    await signInAsFreshUser(page, mentorEmail, pw, '/mentor');
    await page.goto('/mentor/email');

    // Nothing selected yet — nothing to summarise.
    const summary = page.getByTestId('recipient-languages');
    await expect(page.getByText('Lang Mix German')).toBeVisible({ timeout: 15_000 });
    await expect(summary).toHaveCount(0);

    // Tick both mentees: the summary names both languages.
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('checkbox').nth(2).check();
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId('language-badge-de')).toBeVisible();
    await expect(summary.getByTestId('language-badge-tr')).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(deEmail);
    await cleanupByEmail(trEmail);
  }
});
