import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { TEXT_LIMITS } from '@/lib/textLimits';
import {
  ADMIN_READ_ONLY_ERROR,
  announceSessionNoteChange,
  canAuthor,
  recordRevision,
  serializeSessionNote,
  sessionNoteIfAllowed,
  sessionNoteInclude,
  viewerOf,
} from '@/lib/sessionNoteAccess';

// One shared note (#1847). 'missing' is a 404 for another tenant's note too,
// so the id confirms nothing (#2542); a tenant-mate outside the pairing gets 403.

const patchSchema = z.object({ body: z.string().trim().min(1).max(TEXT_LIMITS.sessionNoteBody) });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const note = await sessionNoteIfAllowed(session, id);
    if (note === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!note) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ note: serializeSessionNote(note) });
  });
}

// PATCH — edit the minutes. Either seat may; the edit is recorded as a revision
// naming the editor. An admin reads only; the mentee of a finished mentorship
// gets the usual 409.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const note = await sessionNoteIfAllowed(session, id);
    if (note === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!note) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const viewer = viewerOf(session);
    if (!canAuthor(note.relation, viewer)) return NextResponse.json(ADMIN_READ_ONLY_ERROR, { status: 403 });
    if (menteeWriteClosed(note.relation, session.user.id)) return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    // Saving the same text again is not an edit and writes no revision.
    if (parsed.data.body !== note.body) {
      await prisma.sessionNote.update({ where: { id: note.id }, data: { body: parsed.data.body } });
      await recordRevision(note.id, session.user.id, parsed.data.body);
      announceSessionNoteChange(note.relation, note.relationId, session.user.id);
    }
    const updated = await prisma.sessionNote.findUniqueOrThrow({ where: { id: note.id }, include: sessionNoteInclude });
    return NextResponse.json({ note: serializeSessionNote(updated) });
  });
}
