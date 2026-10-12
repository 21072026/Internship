import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1847: the pair's SHARED minutes — a third note model beside the two private
// ones. The first test is the boundary (hence @smoke): mentor writes → mentee
// reads → mentee edits (a revision names the editor); a third party is 403 on
// read and write; an admin reads but does not author; an archived mentorship
// answers the existing 409; and PersonalNote stays author-only, proven against
// the same people. The second test drives the panel.

const PASSWORD = 'Pass1234!';

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const strangerEmail = uniqueEmail(`${prefix}-stranger`);
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Minutes Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Minutes Mentee');
  const stranger = await seedUser(strangerEmail, PASSWORD, 'MENTOR', 'Minutes Stranger');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Minutes Admin');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const cleanup = async () => {
    await prisma.sessionNote.deleteMany({ where: { relationId: rel.id } });
    await prisma.personalNote.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(strangerEmail);
    await cleanupByEmail(adminEmail);
  };
  return { mentorEmail, menteeEmail, strangerEmail, adminEmail, mentor, mentee, stranger, admin, rel, cleanup };
}

type Note = { id: string; body: string; createdBy: { id: string } | null; lastEditedBy: { id: string } | null; revisions: { author: { id: string } | null; body: string }[] };

test(
  'mentor writes, mentee reads and edits with a revision; a third party is refused, an admin only reads, an archive answers 409, PersonalNote stays private',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const p = await seedPair('minutes');
    const asMentor = await playwright.request.newContext();
    const asMentee = await playwright.request.newContext();
    const asStranger = await playwright.request.newContext();
    const asAdmin = await playwright.request.newContext();
    try {
      for (const [ctx, email] of [[asMentor, p.mentorEmail], [asMentee, p.menteeEmail], [asStranger, p.strangerEmail], [asAdmin, p.adminEmail]] as const) {
        expect((await signInViaApi(ctx, email, PASSWORD)).ok).toBeTruthy();
      }

      // The mentor writes the minutes.
      const written = await asMentor.post('/api/session-notes', {
        data: { relationId: p.rel.id, body: 'Agreed: CV draft by Friday, mock interview next week.' },
      });
      expect(written.status()).toBe(201);
      const note = (await written.json()).note as Note;
      expect(note.createdBy?.id).toBe(p.mentor.id);
      expect(note.revisions).toHaveLength(1);
      expect(note.revisions[0].author?.id).toBe(p.mentor.id);

      // The mentee reads the same note and may write.
      const menteeList = await asMentee.get(`/api/session-notes?relationId=${p.rel.id}`);
      expect(menteeList.status()).toBe(200);
      const menteeBody = (await menteeList.json()) as { notes: Note[]; writable: boolean };
      expect(menteeBody.writable).toBe(true);
      expect(menteeBody.notes.map((n) => n.id)).toEqual([note.id]);
      expect(menteeBody.notes[0].body).toBe('Agreed: CV draft by Friday, mock interview next week.');

      // The mentee edits: the body changes and a revision names them.
      const edited = await asMentee.patch(`/api/session-notes/${note.id}`, {
        data: { body: 'Agreed: CV draft by Friday, mock interview next Tuesday 18:00.' },
      });
      expect(edited.status()).toBe(200);
      const after = (await edited.json()).note as Note;
      expect(after.body).toContain('Tuesday 18:00');
      expect(after.lastEditedBy?.id).toBe(p.mentee.id);
      expect(after.revisions).toHaveLength(2);
      expect(after.revisions[0].author?.id).toBe(p.mentee.id);
      expect(after.revisions[1].author?.id).toBe(p.mentor.id);
      expect(after.revisions[1].body).toBe('Agreed: CV draft by Friday, mock interview next week.');
      const rows = await prisma.sessionNoteRevision.findMany({ where: { noteId: note.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.authorId)).toEqual([p.mentor.id, p.mentee.id]);
      // Saving the identical text is not an edit.
      expect((await asMentor.patch(`/api/session-notes/${note.id}`, { data: { body: after.body } })).status()).toBe(200);
      expect(await prisma.sessionNoteRevision.count({ where: { noteId: note.id } })).toBe(2);
      // The mentor sees the mentee's edit.
      const mentorView = ((await (await asMentor.get(`/api/session-notes/${note.id}`)).json()).note as Note);
      expect(mentorView.body).toContain('Tuesday 18:00');

      // A third party: 403 on read and on write, nothing changes.
      expect((await asStranger.get(`/api/session-notes?relationId=${p.rel.id}`)).status()).toBe(403);
      expect((await asStranger.get(`/api/session-notes/${note.id}`)).status()).toBe(403);
      expect((await asStranger.patch(`/api/session-notes/${note.id}`, { data: { body: 'pwned' } })).status()).toBe(403);
      expect((await asStranger.post('/api/session-notes', { data: { relationId: p.rel.id, body: 'planted' } })).status()).toBe(403);
      expect((await prisma.sessionNote.findUniqueOrThrow({ where: { id: note.id } })).body).toContain('Tuesday 18:00');

      // An admin reads, and is told the minutes are the pair's to write.
      const adminList = (await (await asAdmin.get(`/api/session-notes?relationId=${p.rel.id}`)).json()) as { notes: Note[]; writable: boolean };
      expect(adminList.notes).toHaveLength(1);
      expect(adminList.writable).toBe(false);
      const adminWrite = await asAdmin.post('/api/session-notes', { data: { relationId: p.rel.id, body: 'on their behalf' } });
      expect(adminWrite.status()).toBe(403);
      expect((await adminWrite.json()).code).toBe('admin_read_only');
      const adminEdit = await asAdmin.patch(`/api/session-notes/${note.id}`, { data: { body: 'on their behalf' } });
      expect(adminEdit.status()).toBe(403);
      expect((await adminEdit.json()).code).toBe('admin_read_only');

      // A note pinned to a meeting of another pairing is refused.
      const otherRel = await prisma.mentorshipRelation.create({ data: { mentorId: p.stranger.id, menteeId: p.mentee.id, status: 'COMPLETED', completedAt: new Date() } });
      const otherMeeting = await prisma.meeting.create({ data: { title: 'Elsewhere', relationId: otherRel.id, createdById: p.stranger.id, rsvpToken: `tok-${Date.now()}` } });
      try {
        expect((await asMentor.post('/api/session-notes', { data: { relationId: p.rel.id, body: 'x', meetingId: otherMeeting.id } })).status()).toBe(400);
      } finally {
        await prisma.meeting.deleteMany({ where: { id: otherMeeting.id } });
        await prisma.mentorshipRelation.deleteMany({ where: { id: otherRel.id } });
      }

      // PersonalNote is untouched: the mentor's private note is invisible and
      // unwritable to the mentee of the same pairing, byte for byte as before.
      const privateNote = await asMentor.post('/api/notes', { data: { body: 'Private: she seems overwhelmed, go slower.' } });
      expect(privateNote.status()).toBe(201);
      const privateId = ((await privateNote.json()).note as { id: string }).id;
      const menteeNotes = ((await (await asMentee.get('/api/notes')).json()).notes as { id: string }[]);
      expect(menteeNotes.some((n) => n.id === privateId)).toBe(false);
      expect((await asMentee.patch(`/api/notes/${privateId}`, { data: { body: 'x' } })).status()).toBe(403);
      expect((await asMentee.delete(`/api/notes/${privateId}`)).status()).toBe(403);
      expect((await prisma.personalNote.findUniqueOrThrow({ where: { id: privateId } })).body).toBe('Private: she seems overwhelmed, go slower.');
      // …and the shared minutes list never carries a PersonalNote row.
      const sharedIds = ((await (await asMentee.get(`/api/session-notes?relationId=${p.rel.id}`)).json()).notes as Note[]).map((n) => n.id);
      expect(sharedIds).toEqual([note.id]);

      // An archived mentorship: the mentee reads, cannot write (409
      // inactive_relation), the mentor still can.
      await prisma.mentorshipRelation.update({ where: { id: p.rel.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      const readOnly = (await (await asMentee.get(`/api/session-notes?relationId=${p.rel.id}`)).json()) as { writable: boolean; notes: Note[] };
      expect(readOnly.writable).toBe(false);
      expect(readOnly.notes).toHaveLength(1);
      const locked = await asMentee.post('/api/session-notes', { data: { relationId: p.rel.id, body: 'too late' } });
      expect(locked.status()).toBe(409);
      expect((await locked.json()).code).toBe('inactive_relation');
      const lockedEdit = await asMentee.patch(`/api/session-notes/${note.id}`, { data: { body: 'too late' } });
      expect(lockedEdit.status()).toBe(409);
      expect((await lockedEdit.json()).code).toBe('inactive_relation');
      expect((await asMentor.patch(`/api/session-notes/${note.id}`, { data: { body: 'Closing remark added by the mentor.' } })).status()).toBe(200);
    } finally {
      await asMentor.dispose();
      await asMentee.dispose();
      await asStranger.dispose();
      await asAdmin.dispose();
      await p.cleanup();
    }
  }
);

test('the panel writes minutes, shows who edited, and lists the versions', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await seedPair('minutes-ui');
  try {
    await signInAndSettle(page, p.mentorEmail, PASSWORD, '/mentor');
    await page.goto(`/mentor/mentees/${p.rel.id}`);
    const panel = page.getByTestId('session-note-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText('No minutes yet');

    await panel.getByTestId('session-note-new').click();
    await panel.getByTestId('session-note-draft').fill('We agreed to rewrite the CV summary first.');
    // Wait on the request itself: on a cold dev server the POST queues behind
    // the page's own on-demand compiles for well over ten seconds.
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/session-notes') && r.request().method() === 'POST', { timeout: 60_000 });
    await panel.getByTestId('session-note-save').click();
    expect((await saved).status()).toBe(201);
    const stored = await prisma.sessionNote.findFirstOrThrow({ where: { relationId: p.rel.id } });
    const row = panel.getByTestId(`session-note-${stored.id}`);
    await expect(row).toContainText('We agreed to rewrite the CV summary first.');
    await expect(row).toContainText('Written by Minutes Mentor');

    // Edit in place: the edited-by line and the version count appear.
    await panel.getByTestId(`session-note-edit-${stored.id}`).click();
    await panel.getByTestId(`session-note-editor-${stored.id}`).fill('We agreed to rewrite the CV summary first, then the project list.');
    await panel.getByTestId(`session-note-save-${stored.id}`).click();
    await expect(row.getByTestId(`session-note-body-${stored.id}`)).toContainText('then the project list', { timeout: 10_000 });
    await expect(row.getByTestId('session-note-edited')).toContainText('edited by Minutes Mentor');
    await panel.getByTestId(`session-note-history-${stored.id}`).click();
    const history = row.getByTestId(`session-note-revisions-${stored.id}`);
    await expect(history).toContainText('Current version');
    await expect(history).toContainText('Saved by Minutes Mentor');
    expect(await prisma.sessionNoteRevision.count({ where: { noteId: stored.id } })).toBe(2);
  } finally {
    await p.cleanup();
  }
});
