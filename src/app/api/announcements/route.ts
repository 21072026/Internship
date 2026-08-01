import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { announcementImageUrl } from '@/lib/announcementImage';

// GET — paginated announcement history for the signed-in user. Admin
// broadcasts (POST /api/admin/announcements) always target every active user
// and the Announcement model carries no per-role/org/user targeting fields,
// so any authenticated user reads the same shared history here.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10) || 10));

  const [total, announcements] = await Promise.all([
    prisma.announcement.count(),
    prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // The attached image is referenced by URL, never inlined — selecting
      // `image: { id: true }` keeps the blob out of the JSON payload.
      select: { id: true, text: true, link: true, createdAt: true, image: { select: { id: true } } },
    }),
  ]);

  return NextResponse.json({
    announcements: announcements.map(({ image, ...a }) => ({
      ...a,
      imageUrl: image ? announcementImageUrl(a.id) : null,
    })),
    total,
    page,
    pageSize,
  });
}
