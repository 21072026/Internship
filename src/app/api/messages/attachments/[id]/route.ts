import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessMessage } from '@/lib/conversations';
import { downloadHeaders } from '@/lib/download';

// GET — serve a message attachment's bytes. Only the participants of the
// message's thread or conversation (or an admin) may download it, same rule as
// reading the thread itself.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.messageAttachment.findUnique({
    where: { id },
    include: { message: { select: { relationId: true, conversationId: true } } },
  });
  if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
}
