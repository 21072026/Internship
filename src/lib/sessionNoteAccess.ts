import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { inCallerTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { publishRealtime } from '@/lib/realtimeBus';

// Who may read and write the pair's shared minutes (#1847), in one place.
//
// A SessionNote hangs off a MentorshipRelation, so the rule is the relation's:
// an admin of the tenant, the relation's mentor, or its mentee — exactly
// `relationIfAllowed` in src/app/api/goals/route.ts, copied here (a route
// file may export only HTTP handlers). Another tenant's relation, and so its
// minutes, answers like a missing one (#2542). Two refinements of the
// relation rule are the issue's own:
//   - an ADMIN reads; they do not author or edit on the pair's behalf
//     (`canAuthor`), so the minutes stay the pair's record;
//   - the archived-relation lock (`menteeWriteClosed`) is applied by the
//     routes with the existing 409 `inactive_relation` body.
// PersonalNote and RelationNote are not touched by any of this: the private
// models keep their own, author-only read paths.

export type NoteViewer = { id: string; role: string };

export const sessionNoteRelationSelect = {
  select: { id: true, mentorId: true, menteeId: true, orgId: true, status: true },
} as const;

export type SessionNoteRelation = { id: string; mentorId: string; menteeId: string; orgId: string | null; status: string };

/** How many saved edits a note keeps (#1847: "keep the last N revisions"). */
export const SESSION_NOTE_REVISIONS_KEPT = 20;

export function viewerOf(session: Session): NoteViewer {
  return { id: session.user.id, role: session.user.role };
}

/** Admin of the tenant, or one of the two seats — may READ. */
export function canReachRelation(rel: { mentorId: string; menteeId: string }, viewer: NoteViewer): boolean {
  return viewer.role === 'ADMIN' || rel.mentorId === viewer.id || rel.menteeId === viewer.id;
}

/** One of the two seats — may WRITE. An admin reads only. */
export function canAuthor(rel: { mentorId: string; menteeId: string }, viewer: NoteViewer): boolean {
  return rel.mentorId === viewer.id || rel.menteeId === viewer.id;
}

export const ADMIN_READ_ONLY_ERROR = {
  error: 'The minutes are the pair’s to write',
  code: 'admin_read_only',
} as const;

/**
 * The relation when the caller may see its minutes; null when they may not;
 * 'missing' when it does not exist for this caller (another tenant's).
 */
export async function relationForNotes(session: Session, relationId: string) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, ...sessionNoteRelationSelect });
  if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) return 'missing' as const;
  return canReachRelation(rel, viewerOf(session)) ? rel : null;
}

const author = { select: { id: true, fullName: true } } as const;

export const sessionNoteInclude = {
  createdBy: author,
  meeting: { select: { id: true, title: true, scheduledAt: true } },
  revisions: {
    orderBy: { createdAt: 'desc' as const },
    take: SESSION_NOTE_REVISIONS_KEPT,
    include: { author },
  },
  // The `- [ ]` lines promoted to to-dos (#1849), with the to-do's live state.
  actionItems: {
    orderBy: { createdAt: 'asc' as const },
    include: { task: { select: { id: true, done: true, assignee: author } } },
  },
} as const;

type NoteRow = {
  id: string;
  relationId: string;
  meetingId: string | null;
  agendaId: string | null;
  body: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: { id: string; fullName: string } | null;
  meeting: { id: string; title: string; scheduledAt: Date | null } | null;
  revisions: Array<{ id: string; authorId: string | null; body: string; createdAt: Date; author: { id: string; fullName: string } | null }>;
  actionItems: Array<{ id: string; taskId: string; text: string; task: { id: string; done: boolean; assignee: { id: string; fullName: string } | null } }>;
};

/** The client-facing shape. Revisions newest first; the latest one is the current body's author. */
export function serializeSessionNote(note: NoteRow) {
  const latest = note.revisions[0] ?? null;
  return {
    id: note.id,
    relationId: note.relationId,
    meetingId: note.meetingId,
    agendaId: note.agendaId,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    createdBy: note.createdBy,
    lastEditedBy: latest?.author ?? note.createdBy,
    meeting: note.meeting
      ? { id: note.meeting.id, title: note.meeting.title, scheduledAt: note.meeting.scheduledAt?.toISOString() ?? null }
      : null,
    revisions: note.revisions.map((r) => ({
      id: r.id,
      author: r.author,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    })),
    actionItems: note.actionItems.map((a) => ({
      taskId: a.taskId,
      text: a.text,
      done: a.task.done,
      assignee: a.task.assignee,
    })),
  };
}

/**
 * Load one note for a caller. 'missing' covers another tenant's note too; null
 * means "exists, in your tenant, but you are not in this mentorship".
 */
export async function sessionNoteIfAllowed(session: Session, noteId: string) {
  const note = await prisma.sessionNote.findUnique({
    where: { id: noteId },
    include: { ...sessionNoteInclude, relation: sessionNoteRelationSelect },
  });
  if (!note || !(await inCallerTenant(note.relation.orgId, resolveOrgId(session)))) return 'missing' as const;
  if (!canReachRelation(note.relation, viewerOf(session))) return null;
  return note;
}

/**
 * Record a saved body as a revision and trim the trail to the last N. Called
 * after every create and every edit, so revision[0] is always the current body.
 */
export async function recordRevision(noteId: string, authorId: string, body: string) {
  await prisma.sessionNoteRevision.create({ data: { noteId, authorId, body } });
  const stale = await prisma.sessionNoteRevision.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    skip: SESSION_NOTE_REVISIONS_KEPT,
    select: { id: true },
  });
  if (stale.length > 0) await prisma.sessionNoteRevision.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

/** Tell both seats (and the actor's other tabs) that the minutes changed. */
export function announceSessionNoteChange(rel: { mentorId: string; menteeId: string }, relationId: string, actorId: string) {
  publishRealtime([rel.mentorId, rel.menteeId, actorId], { type: 'sessionNote', relationId, senderId: actorId });
}
