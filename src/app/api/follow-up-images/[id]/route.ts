import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { followUpImageAccess } from '@/lib/followUpImages';

// One follow-up image's bytes (#3931). Readable by whoever may read the
// follow-up note of its record (src/lib/followUpImages.ts); a draft only by
// the person who uploaded it. Anything else — another org's, another rep's
// record, a missing id — is the same 404. The type was read from the bytes at
// upload (followUpImageRule.ts), and the response is never sniffed or cached.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const image = await prisma.followUpImage.findUnique({
      where: { id },
      select: { relationId: true, uploaderId: true, attachedAt: true, contentType: true, size: true, data: true },
    });
    if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const access = await followUpImageAccess(session, image.relationId);
    const allowed = image.attachedAt ? !!access?.read : !!access?.write && image.uploaderId === session.user.id;
    if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(Buffer.from(image.data), {
      headers: {
        'Content-Type': image.contentType,
        'Content-Length': String(image.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
}
