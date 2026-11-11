import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere } from '@/lib/tenantFilter';
import { actorFromSession, can } from '@/lib/authz';

// GET — the image attached to an announcement. Gated on any authenticated
// session, matching GET /api/announcements: an untargeted broadcast reaches all
// active users, so the body and its image share one audience; a targeted or not
// yet sent one is narrowed below by the same rule the feed applies (#1721).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  // Only an image of the caller's own tenant (cross-world isolation): another
  // org's is a 404, the same answer as an id that does not exist.
  const image = await prisma.announcementImage.findFirst({
    where: { announcementId: id, announcement: { is: await tenantWhere(session) } },
    include: { announcement: { select: { status: true, targeted: true } } },
  });
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // The reader feed's rule (#1721): an unsent (scheduled, cancelled) or a
  // targeted announcement's image is for the people it reached — and for the
  // admins who compose and review them. Anyone else gets the same 404.
  const restricted = image.announcement.status !== 'SENT' || image.announcement.targeted;
  const actor = restricted ? await actorFromSession(session) : null;
  if (restricted && !(actor && (await can(actor, 'content.read', undefined, session)))) {
    const delivered = await prisma.notification.findFirst({
      where: { userId: session.user.id, announcementId: id },
      select: { id: true },
    });
    if (!delivered || image.announcement.status !== 'SENT') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return new NextResponse(Buffer.from(image.data), {
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.size),
      // The bytes were type-checked on upload, but announcements are read by
      // every user: nosniff + an inline disposition keep a mislabelled blob from
      // being interpreted as anything but an image.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
