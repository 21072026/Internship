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
import { withTenantScope } from '@/lib/orgContext';

// User side of the support channel (#593): every role has a pinned "Support"
// conversation. The first message opens a SupportTicket; further messages join
// the user's open (OPEN/IN_PROGRESS) ticket; a closed ticket means the next
// message opens a fresh one. Separate from the mentorship message API.

const postSchema = z.object({ body: z.string().min(1).max(5000) });
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
    let payload: unknown;
    let files: File[] = [];

    if (
      request.headers
        .get('content-type')
        ?.includes('multipart/form-data')
    ) {
      const form = await request.formData().catch(() => null);

      if (!form) {
        return NextResponse.json(
          { error: 'Invalid multipart request' },
          { status: 400 },
        );
      }

      payload = {
        body: form.get('body'),
      };

      files = form
        .getAll('files')
        .filter((value): value is File => value instanceof File);
    } else {
      // Eski JSON text-only API desteği korunur.
      payload = await request.json().catch(() => null);
    }

    const parsed = postSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      );
    }

    const body = parsed.data.body.trim();

    if (!body) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      );
    }

    if (files.length > SUPPORT_ATTACHMENT_MAX_COUNT) {
      return NextResponse.json(
        {
          error: `Too many attachments (max ${SUPPORT_ATTACHMENT_MAX_COUNT})`,
        },
        { status: 400 },
      );
    }

    const fileKeys = new Set<string>();

    for (const file of files) {
      const key = [
        file.name,
        file.size,
        file.type,
        file.lastModified,
      ].join('\0');

      if (fileKeys.has(key)) {
        return NextResponse.json(
          { error: `Duplicate attachment: ${file.name}` },
          { status: 400 },
        );
      }

      fileKeys.add(key);

      const validationError = await validateSupportFile(file);

      if (validationError) {
        const errors = {
          unsupported: `Unsupported file type: ${file.name}`,
          tooLarge: `File too large: ${file.name}`,
          unreadable: `File is empty, corrupted, or unreadable: ${file.name}`,
        };

        return NextResponse.json(
          { error: errors[validationError] },
          { status: 400 },
        );
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
            subject: body.slice(0, 80),
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

    const text = result.isNew
      ? `New support ticket from ${session.user.name ?? 'a user'}.`
      : `New support message from ${session.user.name ?? 'a user'}.`;

    await Promise.all(
      admins.map((admin) =>
        notify(
          admin.id,
          'support',
          text,
          '/admin/support',
        ),
      ),
    );

    return NextResponse.json(result, { status: 201 });
  });
}
