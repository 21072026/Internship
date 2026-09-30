import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere } from '@/lib/tenantFilter';

// GET — the image attached to an announcement. Gated on any authenticated
// session, matching GET /api/announcements: every admin broadcast targets all
// active users, so the body and its image share one audience.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  // Only an image of the caller's own tenant (cross-world isolation): another
  // org's is a 404, the same answer as an id that does not exist.
  const image = await prisma.announcementImage.findFirst({
    where: { announcementId: id, announcement: { is: await tenantWhere(session) } },
  });
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
