import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const markReadSchema = z.object({
  id: z.string().min(1).optional(),
});

const READ_FILTERS = new Set(['all', 'read', 'unread']);

// Longest `q` the search accepts (#1646). A `contains` on a TEXT column is a
// scan; the cap keeps the pattern short and makes the parameter uninteresting
// to anyone probing it. Longer input is truncated rather than rejected — a
// pasted paragraph should narrow the list, not error.
const MAX_SEARCH_LENGTH = 100;

// GET — the current user's notifications. With no query params this returns
// the last 20 (unfiltered) + unread count, exactly as before (NotificationBell
// depends on this default shape). Optional `page`/`pageSize`/`read`/`type`/`q`
// params add pagination, filtering and text search for the /notifications
// history page.
//
// WHAT `q` CAN AND CANNOT SEE. It matches `Notification.text`, and `text` is
// null on every row written through the i18n contract (#921): those carry
// `params` and are rendered from the dictionary in the READER'S locale at
// display time, so the sentence the user is searching for exists only in the
// browser and never in a column. `q` therefore finds announcements and legacy
// rows, and misses the templated ones — searching the rendered label would mean
// re-rendering every row in every locale on the server, which is a different
// feature (deliberately out of scope here). The type filter is the usable
// handle on templated rows.
//
// That limitation is stated to the READER too, not only here: /notifications
// carries it as a hint under the search box and repeats it when a search
// matches nothing (`notifications.searchHint`). A silent "no notification
// matches your search" over a row that is sitting unfiltered one keystroke away
// reads as a broken search, which is worse than a narrow one.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20));
  const readParam = searchParams.get('read') || 'all';
  const read = READ_FILTERS.has(readParam) ? readParam : 'all';
  const type = searchParams.get('type') || undefined;
  const q = (searchParams.get('q') || '').trim().slice(0, MAX_SEARCH_LENGTH);

  const where = {
    userId: session.user.id,
    ...(read === 'unread' ? { read: false } : read === 'read' ? { read: true } : {}),
    ...(type ? { type } : {}),
    // See the note above: only rows that actually store their sentence.
    ...(q ? { text: { contains: q } } : {}),
  };

  const [items, total, unread, typeRows] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: session.user.id, read: false } }),
    prisma.notification.findMany({
      where: { userId: session.user.id },
      distinct: ['type'],
      select: { type: true },
      orderBy: { type: 'asc' },
    }),
  ]);

  return NextResponse.json({
    items,
    unread,
    total,
    page,
    pageSize,
    types: typeRows.map((r) => r.type),
  });
}

// POST — mark notifications read (all, or a single id via { id }).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const parsed = markReadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }

  await prisma.notification.updateMany({
    where: { userId: session.user.id, ...(parsed.data.id ? { id: parsed.data.id } : {}) },
    data: { read: true },
  });
  return NextResponse.json({ ok: true });
}
