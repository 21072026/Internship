import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { unreadCounts } from '@/lib/unreadCounts';

// GET — number of unread incoming messages across the viewer's mentorship
// threads and conversations (#769). Without the conversation arm, project DMs
// would never reach the unread badge.
//
// The counting itself lives in src/lib/unreadCounts.ts (#1464) so this endpoint
// and the live stream can never drift apart. `notifications` is returned
// alongside `count` so a client that has fallen back to polling can keep both
// header badges fresh from one request; `count` is kept as-is for the callers
// that predate it.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const counts = await unreadCounts(session.user.id);
  return NextResponse.json({ count: counts.messages, ...counts });
}
