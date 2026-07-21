import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed } from '@/lib/messaging';

// Load a message and confirm the caller may see its thread. Returns the message
// (with relation ids) or null when not found / not allowed.
async function loadAllowed(userId: string, role: string, messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) return null;
  const rel = await getThreadIfAllowed({ id: userId, role }, message.relationId);
  if (!rel) return null;
  return message;
}

const editSchema = z.object({ body: z.string().min(1).max(5000) });

// PATCH — edit a message's body. Only the sender may edit, and not once it has
// been deleted for everyone. Sets editedAt so the UI can show "(edited)".
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const message = await loadAllowed(session.user.id, session.user.role, id);
  if (!message) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (message.senderId !== session.user.id) {
    return NextResponse.json({ error: 'Only the sender can edit' }, { status: 403 });
  }
  if (message.deletedForEveryoneAt) {
    return NextResponse.json({ error: 'Message deleted' }, { status: 409 });
  }

  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  await prisma.message.update({
    where: { id },
    data: { body: parsed.data.body, editedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}

// DELETE ?scope=everyone|me
//  - everyone: only the sender (or an admin) — masks the message for all viewers
//    (body/attachments are dropped server-side, a placeholder is shown).
//  - me: any participant/admin — hides the message from their own view only.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const scope = new URL(request.url).searchParams.get('scope') === 'me' ? 'me' : 'everyone';

  const message = await loadAllowed(session.user.id, session.user.role, id);
  if (!message) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (scope === 'me') {
    await prisma.messageHiddenFor.upsert({
      where: { messageId_userId: { messageId: id, userId: session.user.id } },
      create: { messageId: id, userId: session.user.id },
      update: {},
    });
    return NextResponse.json({ ok: true, scope });
  }

  // scope === 'everyone'
  const isSender = message.senderId === session.user.id;
  if (!isSender && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only the sender can delete for everyone' }, { status: 403 });
  }
  if (!message.deletedForEveryoneAt) {
    // Drop the body and any attachments so the content can't be recovered.
    await prisma.$transaction([
      prisma.messageAttachment.deleteMany({ where: { messageId: id } }),
      prisma.message.update({ where: { id }, data: { body: '', deletedForEveryoneAt: new Date() } }),
    ]);
  }
  return NextResponse.json({ ok: true, scope });
}
