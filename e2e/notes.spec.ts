import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee can create and delete private personal notes (owner-only)', async ({ page }) => {
  const email = uniqueEmail('note-mentee');
  const other = await seedUser(uniqueEmail('note-other'), 'x', 'MENTEE', 'Other');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Note Mentee');
  let noteId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const created = await page.request.post('/api/notes', { data: { body: 'Prep for interview' } });
    expect(created.status()).toBe(201);
    noteId = (await created.json()).note.id;

    const list = await (await page.request.get('/api/notes')).json();
    expect(list.notes.some((n: { id: string }) => n.id === noteId)).toBeTruthy();

    // Another user cannot edit/delete it (owner-only).
    const otherNote = await prisma.personalNote.create({ data: { userId: other.id, body: 'theirs' } });
    const forbidden = await page.request.delete(`/api/notes/${otherNote.id}`);
    expect(forbidden.status()).toBe(403);

    // Owner can delete their own.
    const del = await page.request.delete(`/api/notes/${noteId}`);
    expect(del.ok()).toBeTruthy();
    await prisma.personalNote.deleteMany({ where: { id: otherNote.id } });
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: other.id } });
    await cleanupByEmail(other.email);
    await cleanupByEmail(email);
  }
});
