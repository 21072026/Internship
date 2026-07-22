import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';

// User side of the support channel (#593): every role has a pinned "Support"
// conversation. The first message opens a SupportTicket; further messages join
// the user's open (OPEN/IN_PROGRESS) ticket; a closed ticket means the next
// message opens a fresh one. Separate from the mentorship message API.

const postSchema = z.object({ body: z.string().min(1).max(5000) });

// GET — the caller's tickets (newest first) with their messages. Admin replies
// are marked read on view, mirroring the mentorship thread behaviour.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const tickets = await prisma.supportTicket.findMany({
      where: { requesterId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        subject: true,
        createdAt: true,
        closedAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: { id: true, body: true, createdAt: true, senderId: true, sender: { select: { fullName: true, role: true } } },
        },
      },
    });

    await prisma.supportMessage.updateMany({
      where: { ticket: { requesterId: session.user.id }, senderId: { not: session.user.id }, readAt: null },
      data: { readAt: new Date() },
    });

    return NextResponse.json({ tickets, me: session.user.id });
  });
}

// POST — send a message to support.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const body = parsed.data.body.trim();
    if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    let ticket = await prisma.supportTicket.findFirst({
      where: { requesterId: session.user.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    const isNew = !ticket;
    if (!ticket) {
      ticket = await prisma.supportTicket.create({
        data: { requesterId: session.user.id, subject: body.slice(0, 80) },
        select: { id: true, status: true },
      });
    }

    const message = await prisma.supportMessage.create({
      data: { ticketId: ticket.id, senderId: session.user.id, body },
      select: { id: true, createdAt: true },
    });
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });

    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    const text = isNew
      ? `New support ticket from ${session.user.name ?? 'a user'}.`
      : `New support message from ${session.user.name ?? 'a user'}.`;
    await Promise.all(admins.map((a) => notify(a.id, 'support', text, '/admin/support')));

    return NextResponse.json({ ticketId: ticket.id, messageId: message.id, isNew }, { status: 201 });
  });
}
