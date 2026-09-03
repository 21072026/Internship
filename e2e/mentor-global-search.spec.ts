import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor global search finds own mentee and navigates to their profile, not another mentor\'s mentee', async ({ page }) => {
  const mentorEmail = uniqueEmail('gsmentor');
  const otherMentorEmail = uniqueEmail('gsothermentor');
  const menteeEmail = uniqueEmail('gsmentee');
  const otherMenteeEmail = uniqueEmail('gsothermentee');

  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Search Mentor');
  const otherMentor = await seedUser(otherMentorEmail, 'MentorPass123', 'MENTOR', 'Other Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Quixara Voltmoss');
  const otherMentee = await seedUser(otherMenteeEmail, 'x', 'MENTEE', 'Quixara Brindlewick');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.mentorshipRelation.create({ data: { mentorId: otherMentor.id, menteeId: otherMentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // API only returns own mentee, not the other mentor's, even on a shared prefix.
    const res = await page.request.get('/api/search?q=Quixara');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const ids = (data.users ?? []).map((u: { id: string }) => u.id);
    expect(ids).toContain(mentee.id);
    expect(ids).not.toContain(otherMentee.id);

    // UI: search own mentee, click result, land on their relation page.
    // Wait for the debounced search request to actually resolve before looking for
    // the result button — on a cold dev server the first hit to /mentor and
    // /api/search triggers an on-demand compile that can stall the response past
    // the button's own actionability window, so the two waits must not be collapsed
    // into one implicit timeout.
    const searchResponse = page.waitForResponse((r) => r.url().includes('/api/search') && r.url().includes('Quixara'));
    await page.locator('[data-testid="global-search-input"]').fill('Quixara Voltmoss');
    await searchResponse;
    // The results panel is a combobox listbox now (#2075): options carry
    // role="option", not role="button".
    await page.getByRole('option', { name: new RegExp(mentee.fullName) }).click();
    await page.waitForURL((u) => u.pathname === `/mentor/mentees/${relation.id}`, { timeout: 10_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherMenteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherMentorEmail);
  }
});
