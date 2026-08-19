import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import {
  SUPPORT_ATTACHMENT_MAX_COUNT,
  validateSupportFile,
} from '@/lib/supportAttachments';

const ATTACHMENT_SELECT = { id: true, filename: true, contentType: true, size: true } as const;

// Admin side of the support channel (#594): the queue at /admin/support.
// Admins see every ticket, reply into the thread, move tickets through
// OPEN → IN_PROGRESS → CLOSED (and back), and take assignment.

const replySchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().max(5000).optional().default(''),
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

  let payload: unknown;
  let files: File[] = [];

  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: 'Invalid multipart request' }, { status: 400 });
    payload = { ticketId: form.get('ticketId'), body: form.get('body') ?? '' };
    files = form.getAll('files').filter((value): value is File => typeof value !== 'string');
  } else {
    payload = await request.json().catch(() => null);
  }

  const parsed = replySchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const body = parsed.data.body.trim();
  if (!body && files.length === 0) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  if (files.length > SUPPORT_ATTACHMENT_MAX_COUNT) {
    return NextResponse.json(
      { error: `Too many attachments (max ${SUPPORT_ATTACHMENT_MAX_COUNT})` },
      { status: 400 },
    );
  }

  const fileKeys = new Set<string>();
  for (const file of files) {
    const key = [file.name, file.size, file.type, file.lastModified].join('\0');
    if (fileKeys.has(key)) {
      return NextResponse.json({ error: `Duplicate attachment: ${file.name}` }, { status: 400 });
    }
    fileKeys.add(key);

    const validationError = await validateSupportFile(file);
    if (validationError) {
      const errors = {
        unsupported: `Unsupported file type: ${file.name}`,
        tooLarge: `File too large: ${file.name}`,
        unreadable: `File is empty, corrupted, or unreadable: ${file.name}`,
      };
      return NextResponse.json({ error: errors[validationError] }, { status: 400 });
    }
  }

  const attachments = await Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      contentType: file.type,
      size: file.size,
      data: Buffer.from(await file.arrayBuffer()),
    })),
  );

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: parsed.data.ticketId },
    select: { id: true, status: true, requesterId: true, assignedAdminId: true },
  });
  if (!ticket) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const message = await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      senderId: session.user.id,
      body,
      attachments: attachments.length ? { create: attachments } : undefined,
    },
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

  await notify(ticket.requesterId, 'support.replied', {}, '/messages/support');

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
    await notify(ticket.requesterId, 'support.closed', {}, '/messages/support');
  }

  return NextResponse.json({ ticket: updated });
}
