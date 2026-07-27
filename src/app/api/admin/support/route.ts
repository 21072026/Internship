import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';

const ATTACHMENT_SELECT = { id: true, filename: true, contentType: true, size: true } as const;

// Admin side of the support channel (#594): the queue at /admin/support.
// Admins see every ticket, reply into the thread, move tickets through
// OPEN → IN_PROGRESS → CLOSED (and back), and take assignment.

const replySchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().min(1).max(5000),
});

const updateSchema = z.object({
  ticketId: z.string().min(1),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).optional(),
  assignToMe: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

// GET — the full queue, optionally filtered: ?status=OPEN|IN_PROGRESS|CLOSED.
export async function GET(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const statusParam = new URL(request.url).searchParams.get('status');
  const status = ['OPEN', 'IN_PROGRESS', 'CLOSED'].includes(statusParam ?? '')
    ? (statusParam as 'OPEN' | 'IN_PROGRESS' | 'CLOSED')
    : undefined;

  const tickets = await prisma.supportTicket.findMany({
    where: status ? { status } : undefined,
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      status: true,
      subject: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      requester: { select: { id: true, fullName: true, email: true, role: true } },
      assignedAdmin: { select: { id: true, fullName: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true, body: true, createdAt: true, senderId: true, readAt: true,
          sender: { select: { fullName: true, role: true } },
          attachments: { select: ATTACHMENT_SELECT },
        },
      },
    },
  });

  return NextResponse.json({ tickets, me: session.user.id });
}

// POST — reply into a ticket. Replying moves an OPEN ticket to IN_PROGRESS,
// takes assignment if the ticket has none, marks the requester's messages
// read, and notifies the requester.
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const body = parsed.data.body.trim();
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: parsed.data.ticketId },
    select: { id: true, status: true, requesterId: true, assignedAdminId: true },
  });
  if (!ticket) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const message = await prisma.supportMessage.create({
    data: { ticketId: ticket.id, senderId: session.user.id, body },
    select: { id: true },
  });
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      updatedAt: new Date(),
      ...(ticket.status === 'OPEN' ? { status: 'IN_PROGRESS' } : {}),
      ...(ticket.assignedAdminId ? {} : { assignedAdminId: session.user.id }),
    },
  });
  await prisma.supportMessage.updateMany({
    where: { ticketId: ticket.id, senderId: ticket.requesterId, readAt: null },
    data: { readAt: new Date() },
  });

  await notify(ticket.requesterId, 'support', 'Support replied to your message.', '/messages/support');

  return NextResponse.json({ messageId: message.id }, { status: 201 });
}

// PUT — status transitions and assignment.
export async function PUT(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.status && !parsed.data.assignToMe)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: parsed.data.ticketId },
    select: { id: true, status: true, requesterId: true },
  });
  if (!ticket) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { status, assignToMe } = parsed.data;
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      ...(status ? { status, closedAt: status === 'CLOSED' ? new Date() : null } : {}),
      ...(assignToMe ? { assignedAdminId: session.user.id } : {}),
    },
    select: { id: true, status: true, closedAt: true, assignedAdminId: true },
  });

  if (status === 'CLOSED' && ticket.status !== 'CLOSED') {
    await notify(ticket.requesterId, 'support', 'Your support ticket was closed.', '/messages/support');
  }

  return NextResponse.json({ ticket: updated });
}
