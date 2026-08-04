import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1058 / #1059 — the notes window opens with the meeting, and a line of a note
// becomes real work.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('starting a meeting opens the notes window in the same click, bound to that meeting', async ({ page, context }) => {
  const mentorEmail = uniqueEmail('nw-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'NW Mentor');
  const mentee = await seedUser(uniqueEmail('nw-mentee'), 'x', 'MENTEE', 'NW Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    // Stub PiP with a popup so the window is observable; the branch under test
    // is "opened on the click, before the fetch spends the gesture".
    await context.addInitScript(() => {
      Object.defineProperty(window, 'documentPictureInPicture', {
        configurable: true,
        value: {
          window: null,
          requestWindow: () => Promise.resolve(window.open('', '', 'popup=yes,width=380,height=480')),
        },
      });
    });
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/mentees');

    await page.getByTestId(`start-meeting-${rel.id}`).click();
    await page.getByTestId('instant-meeting-topic').fill('Sprint review');

    const [notesWin] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('instant-meeting-confirm').click(),
    ]);

    // Both at once: the room and somewhere to write about it.
    await expect(page.getByTestId('meeting-side-panel')).toBeVisible({ timeout: 15_000 });
    await expect(notesWin.getByTestId('floating-notes-textarea')).toBeVisible();

    // What is typed lands against that meeting, not loose.
    await notesWin.getByTestId('floating-notes-textarea').fill('Ship the changelog');
    await notesWin.getByRole('button', { name: /save now|şimdi kaydet|jetzt speichern/i }).click();

    await expect
      .poll(async () => {
        const note = await prisma.personalNote.findFirst({ where: { userId: mentor.id } });
        return note?.meetingId ? 'linked' : 'loose';
      })
      .toBe('linked');

    const note = await prisma.personalNote.findFirst({ where: { userId: mentor.id } });
    const meeting = await prisma.meeting.findUnique({ where: { id: note!.meetingId! } });
    expect(meeting?.title).toBe('Sprint review');
    expect(note?.category).toBe('MEETING');
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: mentor.id } });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('a note line becomes a goal, once, and the note keeps its text', async ({ page }) => {
  const mentorEmail = uniqueEmail('conv-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Conv Mentor');
  const mentee = await seedUser(uniqueEmail('conv-mentee'), 'x', 'MENTEE', 'Conv Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    const started = await page.request.post('/api/meetings/instant', {
      data: { relationIds: [rel.id], title: 'Planning' },
    });
    const { meetingId } = await started.json();
    const created = await page.request.post('/api/notes', {
      data: { body: 'Discussed scope\nWrite the migration plan\nNothing else', meetingId },
    });
    const { note } = await created.json();

    const res = await page.request.post(`/api/notes/${note.id}/convert`, {
      data: { line: 'Write the migration plan', target: 'GOAL', relationId: rel.id },
    });
    expect(res.status()).toBe(201);

    const goals = await prisma.goal.findMany({ where: { relationId: rel.id } });
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe('Write the migration plan');

    // The note is the record of what was said — the line is marked, not removed.
    const after = await prisma.personalNote.findUnique({ where: { id: note.id } });
    expect(after?.body).toContain('Discussed scope');
    expect(after?.body).toContain('✓ Write the migration plan');

    // Second click on the same line is refused rather than duplicating work.
    const again = await page.request.post(`/api/notes/${note.id}/convert`, {
      data: { line: 'Write the migration plan', target: 'GOAL', relationId: rel.id },
    });
    expect([400, 409]).toContain(again.status());
    expect(await prisma.goal.count({ where: { relationId: rel.id } })).toBe(1);
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.personalNote.deleteMany({ where: { userId: mentor.id } });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test('a line that is not in the note cannot be conjured into a goal', async ({ page }) => {
  const mentorEmail = uniqueEmail('conv2-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Conv2 Mentor');
  const mentee = await seedUser(uniqueEmail('conv2-mentee'), 'x', 'MENTEE', 'Conv2 Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    const created = await page.request.post('/api/notes', { data: { body: 'Only this line' } });
    const { note } = await created.json();

    // Otherwise this endpoint is "create a goal anywhere", wearing a note id.
    const res = await page.request.post(`/api/notes/${note.id}/convert`, {
      data: { line: 'Something never written', target: 'GOAL', relationId: rel.id },
    });
    expect(res.status()).toBe(400);
    expect(await prisma.goal.count({ where: { relationId: rel.id } })).toBe(0);
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.personalNote.deleteMany({ where: { userId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

test("a mentor cannot convert a line onto someone else's mentorship", async ({ page }) => {
  const outsiderEmail = uniqueEmail('conv3-outsider');
  const outsider = await seedUser(outsiderEmail, 'MentorPass123', 'MENTOR', 'Conv3 Outsider');
  const owner = await seedUser(uniqueEmail('conv3-owner'), 'x', 'MENTOR', 'Conv3 Owner');
  const mentee = await seedUser(uniqueEmail('conv3-mentee'), 'x', 'MENTEE', 'Conv3 Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: owner.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, outsiderEmail, 'MentorPass123', '/mentor');
    const created = await page.request.post('/api/notes', { data: { body: 'Do their work' } });
    const { note } = await created.json();

    const res = await page.request.post(`/api/notes/${note.id}/convert`, {
      data: { line: 'Do their work', target: 'GOAL', relationId: rel.id },
    });
    expect(res.status()).toBe(403);
    expect(await prisma.goal.count({ where: { relationId: rel.id } })).toBe(0);
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.personalNote.deleteMany({ where: { userId: outsider.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(owner.email);
    await cleanupByEmail(outsiderEmail);
  }
});
