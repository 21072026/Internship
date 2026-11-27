// A free note on a sales record (#3978) — the rule is src/lib/leadNoteRule.ts.
//
// The writer: one FollowUpEvent NOTE line (followUpNoteWrite), then — when the
// author is not the owner — the owner's bell and mail. The reader side is the
// lead page: the note sits in the record's history with its author and time.
//
// "Previous owner" is read from the record itself, never from the request:
// either an earlier period of the same lead (the `previousRelationId` chain a
// hand-off with history leaves, src/lib/mentorTransfer.ts) was theirs, or a
// HANDED_OFF line on this record names them as the one it came from (the
// in-place hand-off of a record without history).

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { canWriteSalesRecord } from '@/lib/salesBook';
import { followUpNoteWrite } from '@/lib/followUpEvents';
import { notifyIfAllowed } from '@/lib/notify';
import { sendLeadNoteEmail } from '@/services/emailService';
import { leadNoteDedupeKey, mayAddLeadNote, noteNotifiesOwner, parseLeadNote } from '@/lib/leadNoteRule';

const MAX_HOPS = 20;

type NoteRelation = {
  id: string;
  orgId: string | null;
  mentorId: string;
  menteeId: string;
  previousRelationId: string | null;
  cohortId?: string | null;
  companyId?: string | null;
};

/** Whether `userId` owned this lead before and handed it on. */
export async function isPreviousOwner(relation: NoteRelation, userId: string): Promise<boolean> {
  if (relation.mentorId === userId) return false;
  const handedFrom = await prisma.followUpEvent.count({ where: { relationId: relation.id, kind: 'HANDED_OFF', fromUserId: userId } });
  if (handedFrom > 0) return true;
  const seen = new Set<string>([relation.id]);
  let nextId = relation.previousRelationId;
  for (let hops = 0; nextId && !seen.has(nextId) && hops < MAX_HOPS; hops++) {
    seen.add(nextId);
    const link = await prisma.mentorshipRelation.findFirst({
      where: { id: nextId, orgId: relation.orgId, menteeId: relation.menteeId },
      select: { mentorId: true, previousRelationId: true },
    });
    if (!link) break;
    if (link.mentorId === userId) return true;
    nextId = link.previousRelationId;
  }
  return false;
}

/** Whether this viewer may add a note to the record (the page asks the same). */
export async function mayNoteLead(session: Session, relation: NoteRelation): Promise<{ allowed: boolean; writable: boolean; previousOwner: boolean }> {
  const writable = await canWriteSalesRecord(session, relation);
  const previousOwner = writable ? false : await isPreviousOwner(relation, session.user.id);
  return { allowed: mayAddLeadNote({ writable, previousOwner }), writable, previousOwner };
}

export type AddLeadNoteOutcome =
  | { ok: true; notified: boolean }
  | { ok: false; status: 400 | 404; code: 'empty' | 'too_long' | 'missing' };

export async function addLeadNote(opts: { session: Session; orgId: string; relationId: string; text: unknown }): Promise<AddLeadNoteOutcome> {
  const { session, orgId, relationId } = opts;
  const parsed = parseLeadNote(opts.text);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code };

  const relation = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, orgId },
    select: {
      id: true, orgId: true, mentorId: true, menteeId: true, previousRelationId: true, cohortId: true, companyId: true,
      mentee: { select: { fullName: true } },
      mentor: { select: { fullName: true, preferredLanguage: true } },
    },
  });
  // Not yours to note — the same 404 as an id that does not exist.
  if (!relation) return { ok: false, status: 404, code: 'missing' };
  const may = await mayNoteLead(session, relation);
  if (!may.allowed) return { ok: false, status: 404, code: 'missing' };

  const now = new Date();
  const dedupeKey = leadNoteDedupeKey(session.user.id, parsed.text, now);
  const { count } = await followUpNoteWrite({ relationId: relation.id, text: parsed.text, actorId: session.user.id, dedupeKey });

  // The owner hears about a colleague's note — once, even when the click came twice.
  let notified = false;
  if (count === 1 && noteNotifiesOwner({ authorId: session.user.id, ownerId: relation.mentorId })) {
    const from = session.user.name ?? '';
    await notifyIfAllowed(relation.mentorId, 'mentorship', 'lead.noteAdded', { menteeName: relation.mentee.fullName, from }, `/sales/leads/${relation.id}`);
    await sendLeadNoteEmail({
      relationId: relation.id,
      leadName: relation.mentee.fullName,
      fromName: from,
      note: parsed.text,
      recipientName: relation.mentor.fullName,
      orgId,
      userId: relation.mentorId,
      locale: relation.mentor.preferredLanguage,
      dedupeKey: `lead-note:${relation.id}:${dedupeKey}`,
    }).catch(() => {});
    notified = true;
  }
  return { ok: true, notified };
}
