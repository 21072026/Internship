import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1356: an interaction log could only be corrected by deleting and retyping
// it. The edit reuses the add form, sends only what changed, keeps a Call a
// Call, lets the subject be changed, and another mentor's log stays 403.
test('a mentor edits a log: date, type, subject and notes; a Call stays a Call', async ({ page, playwright }, info) => {
  const mentorEmail = uniqueEmail('ie-mentor');
  const otherEmail = uniqueEmail('ie-other');
  const menteeEmail = uniqueEmail('ie-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'IE Mentor');
  await seedUser(otherEmail, 'MentorPass123', 'MENTOR', 'IE Other');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'IE Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const log = await prisma.interactionLog.create({
    data: { relationId: rel.id, date: new Date('2026-01-15'), type: 'Call', subject: 'Old subject', notes: 'Typo in the notez' },
  });
  const other = await playwright.request.newContext({ baseURL: info.project.use.baseURL });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    await page.getByTestId(`interaction-edit-${log.id}`).click();
    const form = page.getByTestId('interaction-log-form');
    await expect(form).toHaveAttribute('data-mode', 'edit');
    await expect(page.getByTestId('interaction-log-notes')).toHaveValue('Typo in the notez');
    // The follow-up shortcut belongs to a new log only.
    await expect(page.getByTestId('interaction-log-follow-up')).toHaveCount(0);

    await page.getByTestId('interaction-log-notes').fill('Typo in the notes, fixed');
    await page.getByTestId('interaction-log-subject').fill('New subject');
    await page.getByTestId('interaction-log-save').click();
    await expect(page.getByTestId('interaction-list').getByText('Typo in the notes, fixed')).toBeVisible({ timeout: 30_000 });

    const saved = await prisma.interactionLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(saved.notes).toBe('Typo in the notes, fixed');
    expect(saved.subject).toBe('New subject');
    expect(saved.type).toBe('Call'); // untouched, kept
    expect(saved.date.toISOString()).toBe('2026-01-15T00:00:00.000Z'); // untouched, not re-sent

    // API: type and date change; an emptied subject clears; a bad date is a 400, not a 500.
    const api = page.request;
    expect((await api.put(`/api/interactions/${log.id}`, { data: { type: 'WhatsApp', date: '2026-02-01', subject: '' } })).ok()).toBeTruthy();
    const after = await prisma.interactionLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after.type).toBe('WhatsApp');
    expect(after.subject).toBeNull();
    expect(after.date.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect((await api.put(`/api/interactions/${log.id}`, { data: { date: 'not-a-date' } })).status()).toBe(400);

    // Another mentor may not edit it (existing rule, kept).
    expect((await signInViaApi(other, otherEmail, 'MentorPass123')).ok).toBe(true);
    expect((await other.put(`/api/interactions/${log.id}`, { data: { notes: 'hijack' } })).status()).toBe(403);
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: log.id } })).notes).not.toBe('hijack');
  } finally {
    await other.dispose();
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    for (const e of [mentorEmail, otherEmail, menteeEmail]) await cleanupByEmail(e);
  }
});
