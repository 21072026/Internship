import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { announcementImageUrl } from '@/lib/announcementImage';
import { resolveAnnouncementText, isAnnouncementFallback } from '@/lib/announcementText';

// GET — paginated announcement history for the signed-in user. Admin
// broadcasts (POST /api/admin/announcements) always target every active user
// and the Announcement model carries no per-role/org/user targeting fields,
// so the only thing that varies per reader is *when they joined*.
//
// A user sees nothing that was broadcast before their account existed (#1161).
// An announcement is a message to the people who were there — "the meeting has
// started", "re-point your git remote today" — not a history lesson for
// whoever signs up next month; read weeks late it is noise at best and
// actively misleading at worst. This covers both surfaces that read this route:
// the dashboard card and the /announcements archive. The per-user notification
// bell already behaves this way for free (rows are created at broadcast time,
// so a later account simply has none). The full record stays available to
// admins at /admin/announcements, which is the sending log.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10) || 10));

  // The cutoff is read from the DB, never from the session/JWT: a token minted
  // before this shipped has no joinedAt claim, and a client-supplied date would
  // be a trivial way to read back the whole archive.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { createdAt: true, preferredLanguage: true },
  });
  // A session pointing at a user row that no longer exists gets an empty feed
  // rather than the entire history.
  if (!me) return NextResponse.json({ announcements: [], total: 0, page, pageSize });
  const where = { createdAt: { gte: me.createdAt } };

  const [total, announcements] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // The attached image is referenced by URL, never inlined — selecting
      // `image: { id: true }` keeps the blob out of the JSON payload.
      select: {
        id: true,
        text: true,
        translations: true,
        link: true,
        createdAt: true,
        image: { select: { id: true } },
      },
    }),
  ]);

  return NextResponse.json({
    // `text` is resolved server-side into this reader's language (#1163), so
    // every client — the card, the archive — stays a plain string renderer and
    // the per-locale bodies never travel to a browser that cannot use them.
    announcements: announcements.map(({ image, translations, ...a }) => ({
      ...a,
      text: resolveAnnouncementText({ text: a.text, translations }, me.preferredLanguage),
      // True when this announcement was written in other languages but not the
      // reader's — the UI says so instead of silently presenting a foreign
      // message as if it had been meant for them.
      languageFallback: isAnnouncementFallback({ translations }, me.preferredLanguage),
      imageUrl: image ? announcementImageUrl(a.id) : null,
    })),
    total,
    page,
    pageSize,
  });
}
