import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1849: the pair's minutes (#1847) become the meeting's interaction log, and
// a `- [ ]` line of the minutes can be promoted to a to-do that stays in step
// with the line. The first test is the API loop: minutes before the log → the
// end click logs the minutes; the sweep logs the placeholder for a meeting
// without minutes → minutes written later replace it in place → a second
// sweep adds nothing; promote → to-do on the right list → tick either side.
// The second drives the panel.

const PASSWORD = 'Pass1234!';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Log Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Log Mentee');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Log Admin');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const meeting = (scheduledAt: Date, title: string) =>
    prisma.meeting.create({
      data: {
        relationId: rel.id,
        title,
        scheduledAt,
        meetLink: `https://meet.example.com/minutes-${crypto.randomBytes(4).toString('hex')}`,
        rsvpToken: `e2e-${crypto.randomBytes(8).toString('hex')}`,
        createdById: mentor.id,
      },
    });
  const cleanup = async () => {
    const tasks = await prisma.sessionNoteActionItem.findMany({ where: { note: { relationId: rel.id } }, select: { taskId: true } });
    await prisma.sessionNote.deleteMany({ where: { relationId: rel.id } });
    await prisma.projectTask.deleteMany({ where: { id: { in: tasks.map((t) => t.taskId) } } });
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  };
  return { mentorEmail, menteeEmail, adminEmail, mentor, mentee, admin, rel, meeting, cleanup };
}

type Note = { id: string; body: string; revisions: { author: { id: string } | null }[]; actionItems: { taskId: string; text: string; done: boolean; assignee: { id: string } | null }[] };

test('minutes become the meeting log (before or after it exists, one row per meeting) and action items become to-dos that stay in step', async ({ page, playwright }) => {
  // Two UI sign-ins plus the whole API loop; the first visit compiles half the API on a cold dev server.
  test.setTimeout(180_000);
  const p = await seedPair('minutes-log');
  const ended = await p.meeting(minutesAgo(10), 'CV review call');
  const swept = await p.meeting(minutesAgo(180), 'Career planning talk');
  const asMentor = await playwright.request.newContext();
  const asMentee = await playwright.request.newContext();
  try {
    expect((await signInViaApi(asMentor, p.mentorEmail, PASSWORD)).ok).toBeTruthy();
    expect((await signInViaApi(asMentee, p.menteeEmail, PASSWORD)).ok).toBeTruthy();

    // The picker offers the pairing's past meetings.
    const list = (await (await asMentor.get(`/api/session-notes?relationId=${p.rel.id}`)).json()) as { meetings: { id: string; hasMinutes: boolean }[]; participants: { id: string }[] };
    expect(list.meetings.map((m) => m.id).sort()).toEqual([ended.id, swept.id].sort());
    expect(list.participants.map((x) => x.id).sort()).toEqual([p.mentor.id, p.mentee.id].sort());

    // 1. Minutes BEFORE the log: the end click logs the minutes, not the placeholder.
    const minutes = 'Decided: apply to two roles this month.\n- [ ] Rewrite the CV summary\n- [ ] Book the mock interview';
    const written = await asMentor.post('/api/session-notes', { data: { relationId: p.rel.id, meetingId: ended.id, body: minutes } });
    expect(written.status()).toBe(201);
    const note = (await written.json()).note as Note;
    expect(await prisma.interactionLog.findUnique({ where: { meetingId: ended.id } })).toBeNull();
    expect((await asMentor.post(`/api/meetings/${ended.id}/end`)).ok()).toBe(true);
    const logA = await prisma.interactionLog.findUniqueOrThrow({ where: { meetingId: ended.id } });
    expect(logA.notes).toBe(minutes);
    expect(logA.autoLogged).toBe(true);
    expect(logA.notes).not.toContain('took place');

    // 2. The sweep logs the placeholder for the meeting without minutes…
    await signInAndSettle(page, p.adminEmail, PASSWORD, '/admin');
    expect((await page.request.get('/api/cron?job=meeting-logs')).ok()).toBe(true);
    const placeholder = await prisma.interactionLog.findUniqueOrThrow({ where: { meetingId: swept.id } });
    expect(placeholder.notes).toContain('took place');
    expect(await prisma.interactionLog.count({ where: { relationId: p.rel.id } })).toBe(2);

    // …minutes written AFTER it replace it in place, and a second sweep adds nothing.
    const later = await asMentee.post('/api/session-notes', { data: { relationId: p.rel.id, meetingId: swept.id, body: 'We mapped three target roles and who to ask for intros.' } });
    expect(later.status()).toBe(201);
    const replaced = await prisma.interactionLog.findUniqueOrThrow({ where: { meetingId: swept.id } });
    expect(replaced.id).toBe(placeholder.id);
    expect(replaced.notes).toBe('We mapped three target roles and who to ask for intros.');
    await page.request.get('/api/cron?job=meeting-logs');
    expect(await prisma.interactionLog.count({ where: { relationId: p.rel.id } })).toBe(2);

    // A hand-written log is never overwritten by minutes.
    await prisma.interactionLog.update({ where: { id: replaced.id }, data: { autoLogged: false, notes: 'Typed by the mentor.' } });
    expect((await asMentee.patch(`/api/session-notes/${(await later.json()).note.id}`, { data: { body: 'Edited minutes.' } })).status()).toBe(200);
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: replaced.id } })).notes).toBe('Typed by the mentor.');

    // 3. Promote a line to the mentee's to-do list, with the mentor as author.
    const promoted = await asMentor.post(`/api/session-notes/${note.id}/action-items`, { data: { text: 'Rewrite the CV summary', assigneeId: p.mentee.id } });
    expect(promoted.status()).toBe(201);
    const { taskId } = (await promoted.json()) as { taskId: string };
    const menteeTodos = (await (await asMentee.get('/api/todos')).json()) as { todos: { id: string; title: string; done: boolean; author: { id: string } | null }[] };
    const todo = menteeTodos.todos.find((x) => x.id === taskId);
    expect(todo?.title).toBe('Rewrite the CV summary');
    expect(todo?.done).toBe(false);
    expect(todo?.author?.id).toBe(p.mentor.id);
    // Guards: the same line twice, a non-seat assignee, a line that is not there.
    expect((await asMentor.post(`/api/session-notes/${note.id}/action-items`, { data: { text: 'rewrite the cv summary', assigneeId: p.mentee.id } })).status()).toBe(409);
    expect((await asMentor.post(`/api/session-notes/${note.id}/action-items`, { data: { text: 'Book the mock interview', assigneeId: p.admin.id } })).status()).toBe(400);
    expect((await asMentor.post(`/api/session-notes/${note.id}/action-items`, { data: { text: 'Not in the minutes', assigneeId: p.mentee.id } })).status()).toBe(400);

    // 4. Ticking the to-do ticks the line (a revision by the ticker) and the log follows.
    expect((await asMentee.patch(`/api/project-tasks/${taskId}`, { data: { done: true } })).status()).toBe(200);
    const afterTick = ((await (await asMentor.get(`/api/session-notes/${note.id}`)).json()).note as Note);
    expect(afterTick.body).toContain('- [x] Rewrite the CV summary');
    expect(afterTick.body).toContain('- [ ] Book the mock interview');
    expect(afterTick.revisions[0].author?.id).toBe(p.mentee.id);
    expect(afterTick.actionItems).toEqual([expect.objectContaining({ taskId, done: true })]);
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { meetingId: ended.id } })).notes).toContain('- [x] Rewrite the CV summary');

    // 5. Ticking the line in the minutes ticks the to-do — and unticking unticks it.
    const second = await asMentee.post(`/api/session-notes/${note.id}/action-items`, { data: { text: 'Book the mock interview', assigneeId: p.mentor.id } });
    expect(second.status()).toBe(201);
    const secondTaskId = ((await second.json()) as { taskId: string }).taskId;
    const ticked = afterTick.body.replace('- [ ] Book the mock interview', '- [x] Book the mock interview');
    expect((await asMentor.patch(`/api/session-notes/${note.id}`, { data: { body: ticked } })).status()).toBe(200);
    expect((await prisma.projectTask.findUniqueOrThrow({ where: { id: secondTaskId } })).done).toBe(true);
    const unticked = ticked.replace('- [x] Rewrite the CV summary', '- [ ] Rewrite the CV summary');
    expect((await asMentor.patch(`/api/session-notes/${note.id}`, { data: { body: unticked } })).status()).toBe(200);
    expect((await prisma.projectTask.findUniqueOrThrow({ where: { id: taskId } })).done).toBe(false);
    // The mentor's own list carries the to-do handed to them, attributed to the mentee.
    const mentorTodos = (await (await asMentor.get('/api/todos')).json()) as { todos: { id: string; author: { id: string } | null }[] };
    expect(mentorTodos.todos.find((x) => x.id === secondTaskId)?.author?.id).toBe(p.mentee.id);

    // 6. The mentee's history shows the real minutes, not the placeholder (the page is still the admin's — switch users properly).
    await signInAsFreshUser(page, p.menteeEmail, PASSWORD, '/portal');
    await page.goto('/portal/interactions');
    await expect(page.getByText('Decided: apply to two roles this month.', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('took place', { exact: false })).toHaveCount(0);
  } finally {
    await asMentor.dispose();
    await asMentee.dispose();
    await p.cleanup();
  }
});

test('the panel pins minutes to a meeting, lists the action items, promotes one and ticks it', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await seedPair('minutes-ui');
  const held = await p.meeting(minutesAgo(30), 'Weekly sync');
  try {
    await signInAndSettle(page, p.mentorEmail, PASSWORD, '/mentor');
    await page.goto(`/mentor/mentees/${p.rel.id}`);
    const panel = page.getByTestId('session-note-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByTestId('session-note-new').click();
    await panel.getByTestId('session-note-meeting').selectOption(held.id);
    await panel.getByTestId('session-note-draft').fill('Good session.\n- [ ] Call the HR contact\n- [ ] Send the thank-you note');
    // Wait on the request itself: on a cold dev server the POST queues behind
    // the page's own on-demand compiles for well over ten seconds.
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/session-notes') && r.request().method() === 'POST', { timeout: 60_000 });
    await panel.getByTestId('session-note-save').click();
    expect((await saved).status()).toBe(201);
    const stored = await prisma.sessionNote.findFirstOrThrow({ where: { relationId: p.rel.id } });
    expect(stored.meetingId).toBe(held.id);
    const row = panel.getByTestId(`session-note-${stored.id}`);
    await expect(row.getByTestId('session-note-meeting-label')).toContainText('Weekly sync');
    const actions = row.getByTestId(`session-note-actions-${stored.id}`);
    await expect(actions.locator('li')).toHaveCount(2);

    // Promote the first line to the mentee, then tick it from the minutes.
    await row.getByTestId(`session-note-action-assignee-${stored.id}-1`).selectOption(p.mentee.id);
    await row.getByTestId(`session-note-action-promote-${stored.id}-1`).click();
    await expect(row.getByTestId(`session-note-action-link-${stored.id}-1`)).toContainText('Log Mentee', { timeout: 10_000 });
    const link = await prisma.sessionNoteActionItem.findFirstOrThrow({ where: { noteId: stored.id }, include: { task: true } });
    expect(link.task.assigneeId).toBe(p.mentee.id);
    expect(link.task.createdById).toBe(p.mentor.id);

    await row.getByTestId(`session-note-action-toggle-${stored.id}-1`).click();
    await expect(row.getByTestId(`session-note-body-${stored.id}`)).toContainText('- [x] Call the HR contact', { timeout: 10_000 });
    await expect.poll(async () => (await prisma.projectTask.findUniqueOrThrow({ where: { id: link.taskId } })).done).toBe(true);
  } finally {
    await p.cleanup();
  }
});
