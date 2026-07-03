import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import { notify } from '@/lib/notify';
import { replyAddress } from '@/lib/replyToken';
import { sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';
import { emailAllowed } from '@/lib/notificationPrefs';
import { ALLOWED_DOC_MIME, MAX_DOC_BYTES } from '@/lib/documentAccess';

const ATTACHMENT_SELECT = { id: true, filename: true, contentType: true, size: true } as const;

// GET ?relationId= — messages in a thread (participants/admin only).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const relationId = new URL(request.url).searchParams.get('relationId') || '';
  const rel = await getThreadIfAllowed(session.user, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const messages = await prisma.message.findMany({
    where: { relationId },
    orderBy: { createdAt: 'asc' },
    include: { attachments: { select: ATTACHMENT_SELECT } },
  });

  // Mark the viewer's incoming unread messages as read.
  await prisma.message.updateMany({
    where: { relationId, senderId: { not: session.user.id }, readAt: null },
    data: { readAt: new Date() },
  });

  return NextResponse.json({
    relationId,
    mentor: rel.mentor,
    mentee: rel.mentee,
    messages,
  });
}

const schema = z.object({ relationId: z.string().min(1), body: z.string().min(1).max(5000) });

// POST — post a message to a thread (participants/admin). Notifies the other
// party. Accepts either JSON (text-only, the original shape) or multipart
// form-data (text + an optional file attachment).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const contentType = request.headers.get('content-type') || '';
  let relationId: string;
  let body: string;
  let file: File | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    relationId = String(form.get('relationId') || '');
    body = String(form.get('body') || '');
    const f = form.get('file');
    if (f instanceof File && f.size > 0) file = f;
    if (!relationId || (!body.trim() && !file) || body.length > 5000) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    }
    if (file) {
      if (!ALLOWED_DOC_MIME.has(file.type)) {
        return NextResponse.json({ error: 'File type not allowed' }, { status: 400 });
      }
      if (file.size > MAX_DOC_BYTES) {
        return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
      }
    }
  } else {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    relationId = parsed.data.relationId;
    body = parsed.data.body;
  }

  const rel = await getThreadIfAllowed(session.user, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const message = await prisma.message.create({
    data: {
      relationId: rel.id,
      senderId: session.user.id,
      body,
      channel: 'IN_APP',
      ...(file
        ? {
            attachments: {
              create: {
                filename: file.name,
                contentType: file.type,
                size: file.size,
                data: Buffer.from(await file.arrayBuffer()),
              },
            },
          }
        : {}),
    },
    include: { attachments: { select: ATTACHMENT_SELECT } },
  });

  // Notify the other participant (unless an admin is posting to someone else's thread).
  const recipient = otherParticipant(rel, session.user.id);
  if (recipient && recipient !== session.user.id) {
    await notify(recipient, 'message', `New message from ${session.user.name ?? 'your mentor'}.`, `/messages/${rel.id}`);

    // Mirror the message to the recipient's inbox (unless they opted out). The
    // Reply-To routes email replies back into this thread via /api/inbound-email.
    const rcpt = await prisma.user.findUnique({
      where: { id: recipient },
      select: { email: true, emailNotifications: true, notificationPrefs: true },
    });
    if (rcpt?.email && emailAllowed(rcpt, 'messages')) {
      const sender = session.user.name ?? 'Your mentor';
      const safe = body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
      sendEmail({
        to: rcpt.email,
        subject: `New message from ${sender}`,
        html: `<p>${sender} sent you a message:</p><blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444">${safe.replace(/\n/g, '<br>')}</blockquote><p>Reply to this email or open the conversation in the app.</p>`,
        replyTo: replyAddress(rel.id),
      }).catch((e) => logger.error('Failed to mirror message email', { error: String(e) }));
    }
  }

  return NextResponse.json({ message }, { status: 201 });
}
