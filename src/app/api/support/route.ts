import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import {
  buildSupportAttachments,
  readSupportMessageRequest,
} from '@/lib/supportMessageRequest';
import { withTenantScope } from '@/lib/orgContext';

// User side of the support channel (#593): every role has a pinned "Support"
// conversation. The first message opens a SupportTicket; further messages join
// the user's open (OPEN/IN_PROGRESS) ticket; a closed ticket means the next
// message opens a fresh one. Separate from the mentorship message API.

const postSchema = z.object({ body: z.string().max(5000).optional().default('') });
const ATTACHMENT_SELECT = { id: true, filename: true, contentType: true, size: true } as const;

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
          select: {
            id: true,
            body: true,
            createdAt: true,
            senderId: true,
            sender: { select: { fullName: true, role: true } },
            attachments: { select: ATTACHMENT_SELECT },
          },
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

  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  return await withTenantScope(session, async () => {
    // multipart (text + files) or the original JSON text-only shape.
    const read = await readSupportMessageRequest(request);

    if (!read.ok) {
      return NextResponse.json({ error: read.error }, { status: read.status });
    }

    const { payload, files } = read;
    const parsed = postSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      );
    }

    const body = parsed.data.body.trim();

    if (!body && files.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      );
    }

    const built = await buildSupportAttachments(files);

    if (!built.ok) {
      return NextResponse.json({ error: built.error }, { status: built.status });
    }

    const attachments = built.attachments;

    const result = await prisma.$transaction(async (tx) => {
      let ticket = await tx.supportTicket.findFirst({
        where: {
          requesterId: session.user.id,
          status: {
            in: ['OPEN', 'IN_PROGRESS'],
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
        },
      });

      const isNew = !ticket;

      if (!ticket) {
        ticket = await tx.supportTicket.create({
          data: {
            requesterId: session.user.id,
            subject: (body || files[0]?.name || 'Attachment').slice(0, 80),
          },
          select: {
            id: true,
          },
        });
      }

      const message = await tx.supportMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: session.user.id,
          body,
          attachments: attachments.length
            ? {
                create: attachments,
              }
            : undefined,
        },
        select: {
          id: true,
        },
      });

      await tx.supportTicket.update({
        where: {
          id: ticket.id,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      return {
        ticketId: ticket.id,
        messageId: message.id,
        isNew,
      };
    });

    const admins = await prisma.user.findMany({
      where: {
        role: 'ADMIN',
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    const from = session.user.name;
    const eventKey = result.isNew
      ? (from ? 'support.new' : 'support.newGeneric')
      : (from ? 'support.newMessage' : 'support.newMessageGeneric');

    await Promise.all(
      admins.map((admin) =>
        notify(
          admin.id,
          eventKey,
          from ? { from } : {},
          '/admin/support',
        ),
      ),
    );

    return NextResponse.json(result, { status: 201 });
  });
}
