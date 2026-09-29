import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessMessage } from '@/lib/conversations';
import { downloadHeaders } from '@/lib/download';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId, sameOrgOrUnknown } from '@/lib/orgScope';

// GET — serve a message attachment's bytes. Only the participants of the
// message's thread or conversation (or an admin) may download it, same rule as
// reading the thread itself.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  return await withTenantScope(session, async () => {
  const attachment = await prisma.messageAttachment.findUnique({
    where: { id },
    include: {
      message: {
        select: {
          relationId: true,
          conversationId: true,
          // The attachment's tenant (#2542): MessageAttachment, Message and
          // Conversation carry no orgId, so it is the thread relation's org, or
          // for a conversation its participants' org.
          relation: { select: { orgId: true } },
          conversation: { select: { participants: { select: { user: { select: { orgId: true } } } } } },
        },
      },
    },
  });
  if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Another org's attachment is 404, never 403 — a 403 would confirm the id.
  // This closes the ADMIN bypass in canAccessMessage across tenants; a real
  // participant is always in the thread's org. Unknown on either side passes.
  const callerOrgId = resolveOrgId(session);
  const { relation, conversation } = attachment.message;
  const inOrg = relation
    ? sameOrgOrUnknown(relation.orgId, callerOrgId)
    : !conversation || conversation.participants.length === 0 ||
      conversation.participants.some((p) => sameOrgOrUnknown(p.user.orgId, callerOrgId));
  if (!inOrg) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!(await canAccessMessage(session.user, attachment.message))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return new NextResponse(Buffer.from(attachment.data), {
    // Images stay inline — MessageThreadView renders them in the thread with an
    // <img>. Everything else downloads (#890), matching the support-attachment
    // route, which already did this.
    headers: downloadHeaders({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      inline: attachment.contentType.startsWith('image/'),
    }),
  });
  });
}
