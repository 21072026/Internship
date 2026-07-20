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
  let files: File[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    relationId = String(form.get('relationId') || '');
    body = String(form.get('body') || '');
    // Accept multiple files (pasted images + picked files). Cap the count.
    files = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0).slice(0, 10);
    if (!relationId || (!body.trim() && files.length === 0) || body.length > 5000) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    }
    for (const file of files) {
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

  // Read each file once into a Buffer, reused for both DB storage and the
  // recipient's email attachments.
  const fileBufs = await Promise.all(
    files.map(async (f) => ({ filename: f.name, contentType: f.type, size: f.size, data: Buffer.from(await f.arrayBuffer()) })),
  );

  const message = await prisma.message.create({
    data: {
      relationId: rel.id,
      senderId: session.user.id,
      body,
      channel: 'IN_APP',
      ...(fileBufs.length
        ? { attachments: { create: fileBufs.map((fb) => ({ filename: fb.filename, contentType: fb.contentType, size: fb.size, data: fb.data })) } }
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
      const attachCount = fileBufs.length;
      sendEmail({
        to: rcpt.email,
        subject: `New message from ${sender}`,
        html: `<p>${sender} sent you a message:</p>${safe.trim() ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444">${safe.replace(/\n/g, '<br>')}</blockquote>` : ''}${attachCount ? `<p>📎 ${attachCount} attachment(s) included.</p>` : ''}<p>Reply to this email or open the conversation in the app.</p>`,
        replyTo: replyAddress(rel.id),
        // Mirror the attachments (incl. pasted images) into the email too.
        attachments: fileBufs.map((fb) => ({ filename: fb.filename, content: fb.data, contentType: fb.contentType })),
      }).catch((e) => logger.error('Failed to mirror message email', { error: String(e) }));
    }
  }

  return NextResponse.json({ message }, { status: 201 });
}
