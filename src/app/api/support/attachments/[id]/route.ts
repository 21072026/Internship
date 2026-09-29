import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resolveOrgId, sameOrgOrUnknown } from '@/lib/orgScope';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const attachment = await prisma.supportAttachment.findUnique({
    where: { id: (await params).id },
    // SupportAttachment → SupportMessage → SupportTicket carry no orgId: the
    // tenant is the ticket requester's (#2542).
    include: { message: { include: { ticket: { select: { requesterId: true, requester: { select: { orgId: true } } } } } } },
  });
  if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Another org's attachment is 404 — before the role check, so a 403 cannot
  // confirm the id. The requester is in their own ticket's org; unknown passes.
  if (!sameOrgOrUnknown(attachment.message.ticket.requester.orgId, resolveOrgId(session))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (session.user.role !== 'ADMIN' && attachment.message.ticket.requesterId !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const disposition = attachment.contentType.startsWith('image/') ? 'inline' : 'attachment';
  return new NextResponse(Buffer.from(attachment.data), {
    headers: {
      'Content-Type': attachment.contentType,
      'Content-Disposition': `${disposition}; filename="${attachment.filename.replace(/["\r\n]/g, '')}"`,
      'Content-Length': String(attachment.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
