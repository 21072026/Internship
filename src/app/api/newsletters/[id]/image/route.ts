import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — an issue's hero image.
//
// Gated on any authenticated session, matching GET /api/newsletters: the
// archive is readable by every signed-in user, so the body and its image share
// one audience. Not used by the e-mail itself — that carries the image inline
// as a cid: attachment, because an <img> pointing here would need a session and
// render broken in every mail client.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const image = await prisma.newsletterImage.findUnique({ where: { newsletterId: id } });
  if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return new NextResponse(Buffer.from(image.data), {
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.size),
      // The bytes were type-checked on upload, but nosniff + an inline
      // disposition keep a mislabelled blob from being interpreted as anything
      // but an image.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
