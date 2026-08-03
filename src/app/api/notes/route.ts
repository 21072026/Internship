import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canAttachNoteToMeeting } from '@/lib/noteMeeting';

// GET — the signed-in user's own private notes. `?meetingId=` narrows them to
// one meeting (#1056); the scope is still the caller's own notes, so no extra
// authorization is needed to read.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const meetingId = new URL(request.url).searchParams.get('meetingId');
  const notes = await prisma.personalNote.findMany({
    where: { userId: session.user.id, ...(meetingId ? { meetingId } : {}) },
    orderBy: { updatedAt: 'desc' },
    // relationId/projectId come along so the panel knows what a line from this
    // note could become — a goal on that mentorship, or a task on that project.
    include: {
      meeting: { select: { id: true, title: true, createdAt: true, relationId: true, projectId: true } },
    },
  });
  return NextResponse.json({ notes });
}

const schema = z.object({
  body: z.string().min(1).max(5000),
  category: z.enum(['MEETING', 'FEEDBACK', 'TASKS', 'PERSONAL']).optional(),
  meetingId: z.string().min(1).optional(),
});

// POST — create a private note.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { meetingId } = parsed.data;
  // The note stays private either way, but the id is a foreign key into someone
  // else's meeting — don't let a note point at a room its author was never in.
  if (meetingId && !(await canAttachNoteToMeeting(session.user, meetingId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const note = await prisma.personalNote.create({
    data: {
      userId: session.user.id,
      body: parsed.data.body,
      category: parsed.data.category ?? (meetingId ? 'MEETING' : 'PERSONAL'),
      meetingId: meetingId ?? null,
    },
  });
  return NextResponse.json({ note }, { status: 201 });
}
