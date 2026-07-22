import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee can create, edit, and delete private personal notes (owner-only)', async ({ page }) => {
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

    await page.goto('/portal/notes');
    const note = page.getByTestId(`note-${noteId}`);
    await expect(note.getByText('Prep for interview')).toBeVisible();

    // Cancelling an edit keeps the original note unchanged.
    await note.getByLabel('Edit').click();
    await note.locator('textarea').fill('Discard this draft');
    await note.getByRole('button', { name: 'Cancel' }).click();
    await expect(note.getByText('Prep for interview')).toBeVisible();
    await expect(note.getByText('Discard this draft')).toHaveCount(0);

    // Whitespace-only content cannot be submitted.
    await note.getByLabel('Edit').click();
    await note.locator('textarea').fill('   ');
    await expect(note.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Saving through the UI persists and displays the revised note.
    await note.locator('textarea').fill('Prepare portfolio for interview');
    await note.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Prepare portfolio for interview')).toBeVisible({ timeout: 10_000 });
    expect((await prisma.personalNote.findUnique({ where: { id: noteId } }))?.body).toBe('Prepare portfolio for interview');

    // Another user cannot edit/delete it (owner-only).
    const otherNote = await prisma.personalNote.create({ data: { userId: other.id, body: 'theirs' } });
    const forbiddenEdit = await page.request.patch(`/api/notes/${otherNote.id}`, { data: { body: 'not allowed' } });
    expect(forbiddenEdit.status()).toBe(403);
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
