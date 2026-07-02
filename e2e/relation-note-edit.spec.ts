import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #443 (B1): mentor-private notes can now be edited, not just deleted.
test('a mentor can edit their own private note', async ({ page }) => {
  const mentorEmail = uniqueEmail('rne-mentor');
  const menteeEmail = uniqueEmail('rne-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'RNE Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'RNE Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'Pass1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Create a note, then edit it via PATCH (shares the logged-in session).
    const created = await page.request.post('/api/relation-notes', {
      data: { relationId: rel.id, body: 'first draft' },
    });
    expect(created.ok()).toBeTruthy();
    const noteId = (await created.json()).note?.id ?? (await (await page.request.get(`/api/relation-notes?relationId=${rel.id}`)).json()).notes[0].id;

    const edited = await page.request.patch(`/api/relation-notes/${noteId}`, { data: { body: 'revised note' } });
    expect(edited.ok()).toBeTruthy();
    expect((await edited.json()).note.body).toBe('revised note');

    // Confirms via the list.
    const list = await (await page.request.get(`/api/relation-notes?relationId=${rel.id}`)).json();
    expect(list.notes.find((n: { id: string; body: string }) => n.id === noteId)?.body).toBe('revised note');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
