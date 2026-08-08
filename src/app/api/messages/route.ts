import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import {
  getConversationIfAllowed,
  otherConversationParticipants,
  canPostToConversation,
  conversationForRelation,
  directCounterpartId,
  latestMentorshipFor,
} from '@/lib/conversations';
import { loadProjectTeam } from '@/lib/projectTeam';
import { notify } from '@/lib/notify';
import { replyAddress } from '@/lib/replyToken';
import { sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';
import { emailAllowed } from '@/lib/notificationPrefs';
import { ALLOWED_DOC_MIME, MAX_DOC_BYTES } from '@/lib/documentAccess';
import { contentMatchesType, CONTENT_MISMATCH_ERROR } from '@/lib/fileType';
import { withTenantScope } from '@/lib/orgContext';

const ATTACHMENT_SELECT = { id: true, filename: true, contentType: true, size: true } as const;

// GET ?relationId= — messages in a thread (participants/admin only).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const params = new URL(request.url).searchParams;
    const relationId = params.get('relationId') || '';
    const conversationId = params.get('conversationId') || '';
    if (!relationId && !conversationId) {
      return NextResponse.json({ error: 'relationId or conversationId required' }, { status: 400 });
    }

    // Authorize through whichever layer the caller addressed: a mentorship
    // thread (legacy relationId) or a conversation (#769). Both fail closed.
    const rel = relationId ? await getThreadIfAllowed(session.user, relationId) : null;
    const conversation = conversationId ? await getConversationIfAllowed(session.user, conversationId) : null;
    if (!rel && !conversation) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Exactly one link is queried — never an OR across both, which would leak
    // messages from the sibling layer into this thread's view.
    const scope = rel ? { relationId: rel.id } : { conversationId: conversation!.id };

    const rows = await prisma.message.findMany({
      // Exclude messages this viewer deleted "for me".
      where: { ...scope, hiddenFor: { none: { userId: session.user.id } } },
      orderBy: { createdAt: 'asc' },
      include: { attachments: { select: ATTACHMENT_SELECT }, reactions: { select: { emoji: true, userId: true } } },
    });

    // Summarize reactions per message: emoji → { count, mine }.
    const summarizeReactions = (reactions: { emoji: string; userId: string }[]) => {
      const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
      for (const r of reactions) {
        const cur = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
        cur.count += 1;
        if (r.userId === session.user.id) cur.mine = true;
        map.set(r.emoji, cur);
      }
      return Array.from(map.values());
    };

    // Mask "deleted for everyone" messages server-side so the original body/
    // attachments never leak; the client renders a placeholder instead.
    const messages = rows.map((m) =>
      m.deletedForEveryoneAt
        ? {
            id: m.id,
            senderId: m.senderId,
            body: '',
            channel: m.channel,
            readAt: m.readAt,
            createdAt: m.createdAt,
            editedAt: null,
            deleted: true,
            attachments: [],
            reactions: [],
          }
        : {
            id: m.id,
            senderId: m.senderId,
            body: m.body,
            channel: m.channel,
            readAt: m.readAt,
            createdAt: m.createdAt,
            editedAt: m.editedAt,
            deleted: false,
            attachments: m.attachments,
            reactions: summarizeReactions(m.reactions),
          },
    );

    // Mark the viewer's incoming unread messages as read.
    await prisma.message.updateMany({
      where: { ...scope, senderId: { not: session.user.id }, readAt: null },
      data: { readAt: new Date() },
    });

    // Conversations also carry a per-participant read cursor.
    if (conversation) {
      await prisma.conversationParticipant.updateMany({
        where: { conversationId: conversation.id, userId: session.user.id },
        data: { lastReadAt: new Date() },
      });
    }

    // A group chat is a room, so it has to say who is in it (#51): the roster is
    // the project's team, annotated onto the participant list so the chat header
    // can show "6 people · who they are" instead of an anonymous thread.
    let group: { type: string; projectId: string | null; projectName: string | null } | null = null;
    let participants: { id: string; fullName: string; role: string | null; functionalRole: string | null }[] = [];
    if (conversation) {
      const team =
        conversation.type === 'GROUP' && conversation.projectId
          ? await loadProjectTeam(conversation.projectId)
          : [];
      const project =
        conversation.type === 'GROUP' && conversation.projectId
          ? await prisma.project.findUnique({ where: { id: conversation.projectId }, select: { name: true } })
          : null;
      group = { type: conversation.type, projectId: conversation.projectId, projectName: project?.name ?? null };
      participants = conversation.participants.map((p) => {
        const member = team.find((m) => m.id === p.user.id);
        return {
          id: p.user.id,
          fullName: p.user.fullName,
          role: member?.role ?? null,
          functionalRole: member?.functionalRole ?? null,
        };
      });
    }

    // Which side of a 1:1 chat is the mentor, when a mentorship stands behind it.
    // The empty-thread openers differ for the two (a mentor welcomes, everyone
    // else says hello), and since the mentorship thread hands over to the
    // conversation (#1156) that has to be answerable here too.
    const counterpartId = conversation ? directCounterpartId(conversation, session.user.id) : null;
    const mentorId = counterpartId ? (await latestMentorshipFor(session.user.id, counterpartId))?.mentorId ?? null : null;

    return NextResponse.json({
      ...(rel
        ? { relationId: rel.id, mentor: rel.mentor, mentee: rel.mentee }
        : {
            conversationId: conversation!.id,
            ...group,
            participants,
            mentorId,
            // Lets the client render the thread read-only instead of failing on
            // send. The POST route enforces the same rule regardless (#770).
            canPost: await canPostToConversation(session.user, conversation!),
          }),
      messages,
    });
  });
}

// Either relationId (mentorship thread) or conversationId (#769) identifies the
// target; `body` may be empty only on the multipart path, where files can stand
// in for text.
const schema = z
  .object({
    relationId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    body: z.string().min(1).max(5000),
  })
  .refine((d) => Boolean(d.relationId) || Boolean(d.conversationId), {
    message: 'relationId or conversationId required',
  });

// POST — post a message to a thread (participants/admin). Notifies the other
// party. Accepts either JSON (text-only, the original shape) or multipart
// form-data (text + an optional file attachment).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const contentType = request.headers.get('content-type') || '';
    let relationId = '';
    let conversationId = '';
    let body: string;
    let files: File[] = [];

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      relationId = String(form.get('relationId') || '');
      conversationId = String(form.get('conversationId') || '');
      body = String(form.get('body') || '');
      // Accept multiple files (pasted images + picked files). Cap the count.
      files = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0).slice(0, 10);
      if ((!relationId && !conversationId) || (!body.trim() && files.length === 0) || body.length > 5000) {
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
      relationId = parsed.data.relationId ?? '';
      conversationId = parsed.data.conversationId ?? '';
      body = parsed.data.body;
    }

    // Same two-layer authorization as GET; both paths fail closed.
    const rel = relationId ? await getThreadIfAllowed(session.user, relationId) : null;
    const conversation = conversationId ? await getConversationIfAllowed(session.user, conversationId) : null;
    if (!rel && !conversation) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Reading a conversation is permanent for its participants, but posting is
    // re-checked against the live permission: someone removed from the shared
    // project can still read the DM's history and no longer add to it (#770).
    if (conversation && !(await canPostToConversation(session.user, conversation))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Read each file once into a Buffer, reused for both DB storage and the
    // recipient's email attachments.
    const fileBufs = await Promise.all(
      files.map(async (f) => ({ filename: f.name, contentType: f.type, size: f.size, data: Buffer.from(await f.arrayBuffer()) })),
    );
    // The MIME check above trusts a client-written header; now that the bytes
    // are in hand, check they agree (#888).
    if (fileBufs.some((f) => !contentMatchesType(f.data, f.contentType))) {
      return NextResponse.json({ error: CONTENT_MISMATCH_ERROR }, { status: 400 });
    }

    // Both links are set whenever both exist (#1156): the conversation is where
    // the thread lives, and the relationId keeps the message inside the
    // mentorship-scoped features (reply-by-email, the unread digest, the
    // onboarding checklist). Addressed by relation, that means resolving the
    // pair's conversation; addressed by conversation, looking up the mentorship
    // behind a 1:1 chat. A project DM between two people with no mentorship, and
    // a group chat, keep a conversationId alone.
    const relConversationId = rel ? (await conversationForRelation(rel))?.id ?? null : null;
    const directOtherId = conversation ? directCounterpartId(conversation, session.user.id) : null;
    const stampRelationId = directOtherId ? (await latestMentorshipFor(session.user.id, directOtherId))?.id ?? null : null;

    const message = await prisma.message.create({
      data: {
        ...(rel
          ? { relationId: rel.id, ...(relConversationId ? { conversationId: relConversationId } : {}) }
          : { conversationId: conversation!.id, ...(stampRelationId ? { relationId: stampRelationId } : {}) }),
        senderId: session.user.id,
        body,
        channel: 'IN_APP',
        ...(fileBufs.length
          ? { attachments: { create: fileBufs.map((fb) => ({ filename: fb.filename, contentType: fb.contentType, size: fb.size, data: fb.data })) } }
          : {}),
      },
      include: { attachments: { select: ATTACHMENT_SELECT } },
    });

    // Notify everyone but the sender — the single other party on a mentorship
    // thread, or every other participant of a conversation. An admin posting
    // into someone else's thread isn't a recipient of their own message.
    const recipients = (
      rel ? [otherParticipant(rel, session.user.id)] : await otherConversationParticipants(conversation!, session.user.id)
    ).filter((id) => id && id !== session.user.id);
    // Always the thread the recipient will actually read it in.
    const threadConversationId = relConversationId ?? conversation?.id ?? null;
    const link = threadConversationId ? `/messages/c/${threadConversationId}` : `/messages/${rel!.id}`;
    // Email replies are routed by a relation-scoped token, so reply-by-email is
    // offered wherever a mentorship stands behind the thread — including the
    // conversation the mentorship thread now redirects to.
    const replyRelationId = rel?.id ?? stampRelationId;

    for (const recipient of recipients) {
      await notify(recipient, 'message', `New message from ${session.user.name ?? 'your mentor'}.`, link);

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
          // Project DMs with no mentorship behind them get the same notification
          // without a Reply-To (see replyRelationId above).
          ...(replyRelationId ? { replyTo: replyAddress(replyRelationId, recipient) } : {}),
          // Mirror the attachments (incl. pasted images) into the email too.
          attachments: fileBufs.map((fb) => ({ filename: fb.filename, content: fb.data, contentType: fb.contentType })),
        }).catch((e) => logger.error('Failed to mirror message email', { error: String(e) }));
      }
    }

    return NextResponse.json({ message }, { status: 201 });
  });
}
