import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — fetch a user's avatar. Any authenticated user may view avatars
// (they're shown across lists, sidebars and profiles).
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const session = await getServerSession(authOptions);
  // Anonymous viewers may only see the avatar of a user with a public profile.
  if (!session) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { publicProfile: true } });
    if (!u?.publicProfile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const avatar = await prisma.avatarFile.findUnique({ where: { userId } });
  if (!avatar) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return new NextResponse(Buffer.from(avatar.data), {
    headers: {
      'Content-Type': avatar.contentType,
      'Content-Length': String(avatar.size),
      'Cache-Control': 'private, max-age=300',
    },
  });
}

// DELETE — remove own avatar (or admin removes anyone's).
export async function DELETE(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  if (userId !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.avatarFile.deleteMany({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
  return NextResponse.json({ ok: true });
}
