import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Session length on an interaction log (#3521). One schema and one writer:
// the app form, the edit route and /api/v1 all go through interactionSchema
// and interactionWrite, so the same `durationMinutes` field is stored whichever
// door wrote it (the chat card's door is pinned in chat-meeting-log.spec.ts).
// The length is shown on the log list, on the timeline, and as a separate
// "time logged" figure on the dashboard — the interaction COUNT is unchanged.

test.afterAll(async () => prisma.$disconnect());

const PW = 'MentorPass123';

test('a mentor records a session length in the form; the API validates and clears it; the count stays a count', async ({ page }) => {
  test.setTimeout(120_000);
  const mentorEmail = uniqueEmail('dur-mentor');
  const menteeEmail = uniqueEmail('dur-mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Duration Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Duration Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  // An older log without a length: it counts as a contact and adds no time.
  await prisma.interactionLog.create({ data: { relationId: rel.id, date: new Date('2026-01-10'), type: 'Email', notes: 'Sent the reading list' } });
  try {
    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: new URL(page.url()).origin }]);
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);

    // The form: a length that is not a whole number in range is refused before anything is sent.
    await page.getByRole('button', { name: 'Add Log' }).click();
    const form = page.getByTestId('interaction-log-form');
    await form.getByTestId('interaction-log-date').fill('2026-02-03');
    await form.getByTestId('interaction-log-notes').fill('Mock interview, system design');
    await form.getByTestId('interaction-log-duration').fill('0');
    await form.getByTestId('interaction-log-save').click();
    await expect(form.getByText('Enter a whole number of minutes between 1 and 600.')).toBeVisible();
    expect(await prisma.interactionLog.count({ where: { relationId: rel.id } })).toBe(1);

    await form.getByTestId('interaction-log-duration').fill('75');
    await form.getByTestId('interaction-log-save').click();
    await expect(page.getByTestId('interaction-list').getByText('Mock interview, system design')).toBeVisible({ timeout: 30_000 });
    const logged = await prisma.interactionLog.findFirstOrThrow({ where: { relationId: rel.id, notes: 'Mock interview, system design' } });
    expect(logged.durationMinutes).toBe(75);
    await expect(page.getByTestId(`interaction-duration-${logged.id}`)).toContainText('1 h 15 min');

    // Editing through the same form changes the same field.
    await page.getByTestId(`interaction-edit-${logged.id}`).click();
    await expect(page.getByTestId('interaction-log-duration')).toHaveValue('75');
    await page.getByTestId('interaction-log-duration').fill('45');
    await page.getByTestId('interaction-log-save').click();
    await expect(page.getByTestId(`interaction-duration-${logged.id}`)).toContainText('45 min', { timeout: 30_000 });
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: logged.id } })).durationMinutes).toBe(45);

    // The timeline shows the length on the interaction row. The panel reads
    // once when the page opens, so reopen the page to read the edited row.
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    const timeline = page.getByTestId('relation-timeline');
    await expect(timeline.locator(`[data-entry-id$=":${logged.id}"]`).getByTestId('timeline-duration')).toContainText('45 min', { timeout: 30_000 });

    // The API: one schema for both doors — out of range and non-integers are 400s, null clears.
    const api = page.request;
    expect((await api.post('/api/interactions', { data: { relationId: rel.id, date: '2026-02-04', type: 'Call', notes: 'x', durationMinutes: 601 } })).status()).toBe(400);
    expect((await api.post('/api/interactions', { data: { relationId: rel.id, date: '2026-02-04', type: 'Call', notes: 'x', durationMinutes: 12.5 } })).status()).toBe(400);
    expect((await api.put(`/api/interactions/${logged.id}`, { data: { durationMinutes: 0 } })).status()).toBe(400);
    const call = await api.post('/api/interactions', { data: { relationId: rel.id, date: '2026-02-05', type: 'Call', notes: 'Quick check-in', durationMinutes: 15 } });
    expect(call.status()).toBe(201);
    const callId: string = (await call.json()).interaction.id;
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: callId } })).durationMinutes).toBe(15);
    expect((await api.put(`/api/interactions/${callId}`, { data: { durationMinutes: null } })).ok()).toBeTruthy();
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: callId } })).durationMinutes).toBeNull();

    // The dashboard: the count is still three logs; the time is its own figure (45 min).
    await gotoSettled(page, '/mentor');
    await expect(page.getByTestId('mentor-logged-time')).toContainText('45 min');
    expect(await prisma.interactionLog.count({ where: { relationId: rel.id } })).toBe(3);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
