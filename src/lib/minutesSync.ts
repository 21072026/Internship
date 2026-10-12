import { prisma } from '@/lib/prisma';
import { findActionItem, setActionItemDone } from '@/lib/minutesActionItems';
import { announceSessionNoteChange, recordRevision } from '@/lib/sessionNoteAccess';

// Real minutes replace the placeholder log, and action items become to-dos
// (#1849). Three one-way bridges, each called from the write that changes one
// side, none of them routed through an HTTP handler — so they cannot loop:
//
//   minutes saved  → the meeting's auto-logged InteractionLog row, in place
//                    (one meeting = one log; the sweep stays idempotent)
//   minutes saved  → every promoted `- [ ]` line's to-do takes the line's state
//   to-do ticked   → the line in the minutes takes the to-do's state, as a
//                    revision by whoever ticked it
//
// A log the mentor typed by hand (autoLogged: false) is never overwritten:
// the minutes only replace what the system wrote because it had nothing better.

/**
 * Mirror the minutes into the meeting's auto-logged interaction row. Returns
 * true when a row was updated; false when the note is not pinned to a meeting,
 * the meeting has no log yet (the sweep or the end click will read the minutes
 * when it writes one), or the log was hand-written.
 */
export async function syncMinutesToMeetingLog(note: { meetingId: string | null; body: string }): Promise<boolean> {
  if (!note.meetingId) return false;
  const body = note.body.trim();
  if (!body) return false;
  const updated = await prisma.interactionLog.updateMany({
    where: { meetingId: note.meetingId, autoLogged: true },
    data: { notes: body },
  });
  return updated.count > 0;
}

/**
 * After the body was saved: every promoted line whose checkbox no longer
 * matches its to-do flips the to-do. A line that was deleted from the minutes
 * leaves its to-do alone — the to-do is still work somebody owns.
 */
export async function syncActionItemsFromMinutes(noteId: string, body: string): Promise<number> {
  const items = await prisma.sessionNoteActionItem.findMany({
    where: { noteId },
    include: { task: { select: { id: true, done: true } } },
  });
  let changed = 0;
  for (const item of items) {
    const line = findActionItem(body, item.text);
    if (!line || line.done === item.task.done) continue;
    await prisma.projectTask.update({
      where: { id: item.task.id },
      data: { done: line.done, doneAt: line.done ? new Date() : null },
    });
    changed++;
  }
  return changed;
}

/**
 * After a to-do was ticked (or unticked): the minutes line it came from takes
 * the same state, saved as a revision by the person who ticked it, and the
 * meeting log mirror follows. Returns true when the minutes changed.
 */
export async function reflectTaskInMinutes(taskId: string, done: boolean, actorId: string): Promise<boolean> {
  const item = await prisma.sessionNoteActionItem.findUnique({
    where: { taskId },
    include: {
      note: {
        select: {
          id: true,
          body: true,
          meetingId: true,
          relationId: true,
          relation: { select: { mentorId: true, menteeId: true } },
        },
      },
    },
  });
  if (!item) return false;
  const next = setActionItemDone(item.note.body, item.text, done);
  if (next === item.note.body) return false;
  await prisma.sessionNote.update({ where: { id: item.note.id }, data: { body: next } });
  await recordRevision(item.note.id, actorId, next);
  await syncMinutesToMeetingLog({ meetingId: item.note.meetingId, body: next });
  announceSessionNoteChange(item.note.relation, item.note.relationId, actorId);
  return true;
}
