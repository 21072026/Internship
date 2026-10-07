import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { loadAccessibleMeeting } from '@/lib/meetingAccess';
import { TEXT_LIMITS } from '@/lib/textLimits';
import {
  ADMIN_READ_ONLY_ERROR,
  announceSessionNoteChange,
  canAuthor,
  recordRevision,
  relationForNotes,
  serializeSessionNote,
  sessionNoteInclude,
  viewerOf,
} from '@/lib/sessionNoteAccess';

// The pair's shared minutes (#1847). Authorization is the relation's
// (src/lib/sessionNoteAccess.ts): admin, mentor, mentee read; mentor and mentee
// write; a finished mentorship takes no new minutes from its mentee (#1408, the
// 409 `inactive_relation` body every relation panel uses). A note pinned to a
// meeting also passes the meeting rule (loadAccessibleMeeting), and the meeting
// must belong to the pairing. Free core: no entitlement check here, ever — the
// capability gate below is the vertical's, not a plan's.

const createSchema = z.object({
  relationId: z.string().min(1),
  body: z.string().trim().min(1).max(TEXT_LIMITS.sessionNoteBody),
  meetingId: z.string().min(1).optional(),
  agendaId: z.string().min(1).optional(),
});

// GET ?relationId=  — every note of the pairing, newest first.
// GET ?meetingId=   — the notes pinned to that meeting.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const sp = new URL(request.url).searchParams;
    const relationId = sp.get('relationId');
    const meetingId = sp.get('meetingId');

    if (meetingId) {
      const meeting = await loadAccessibleMeeting(
        { id: session.user.id, role: session.user.role, orgId: session.user.orgId },
        meetingId
      );
      if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const notes = await prisma.sessionNote.findMany({
        where: { meetingId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: sessionNoteInclude,
      });
      return NextResponse.json({ notes: notes.map(serializeSessionNote) });
    }

    if (!relationId) return NextResponse.json({ error: 'relationId or meetingId required' }, { status: 400 });
    const rel = await relationForNotes(session, relationId);
    if (rel === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const notes = await prisma.sessionNote.findMany({
      where: { relationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: sessionNoteInclude,
    });
    return NextResponse.json({
      notes: notes.map(serializeSessionNote),
      // The panel closes its editor on an archive or for an admin the same way
      // the goals panel does; the server refuses regardless (POST/PATCH).
      writable: canAuthor(rel, viewerOf(session)) && !menteeWriteClosed(rel, session.user.id),
    });
  });
}

// POST — write the minutes of a session.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { relationId, body, meetingId, agendaId } = parsed.data;

    const rel = await relationForNotes(session, relationId);
    if (rel === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!canAuthor(rel, viewerOf(session))) return NextResponse.json(ADMIN_READ_ONLY_ERROR, { status: 403 });
    if (menteeWriteClosed(rel, session.user.id)) return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });

    if (meetingId) {
      const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { relationId: true } });
      if (!meeting || meeting.relationId !== rel.id) {
        return NextResponse.json({ error: 'Meeting is not part of this mentorship' }, { status: 400 });
      }
    }
    if (agendaId) {
      const agenda = await prisma.sessionAgenda.findUnique({ where: { id: agendaId }, select: { relationId: true } });
      if (!agenda || agenda.relationId !== rel.id) {
        return NextResponse.json({ error: 'Agenda is not part of this mentorship' }, { status: 400 });
      }
    }

    const created = await prisma.sessionNote.create({
      data: { relationId: rel.id, body, meetingId: meetingId ?? null, agendaId: agendaId ?? null, createdById: session.user.id },
      select: { id: true },
    });
    await recordRevision(created.id, session.user.id, body);
    const note = await prisma.sessionNote.findUniqueOrThrow({ where: { id: created.id }, include: sessionNoteInclude });
    announceSessionNoteChange(rel, rel.id, session.user.id);
    return NextResponse.json({ note: serializeSessionNote(note) }, { status: 201 });
  });
}
